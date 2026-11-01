import { defaultConfig, type GlobalSettings, type OpStatus, type SecretRef } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import { OpCli, type OpClient, type OpItemInfo } from "../../src/secrets/op.js";
import {
  AVAILABLE_CACHE_TTL_MS,
  SecretsService,
  suggestSecretName,
} from "../../src/secrets/secrets-service.js";
import { FakeRunner } from "../setup/fake-runner.js";

const SECRET = "s3cr3t-value-never-shown";

const ITEM_JSON = JSON.stringify({
  id: "i1",
  title: "Token GitHub",
  fields: [
    { id: "credential", label: "credential", type: "CONCEALED", value: SECRET },
    { id: "empty", label: "notes", type: "STRING", value: "" },
    { id: "otp1", label: "one-time password", type: "OTP", value: "otpauth://totp/x" },
    { id: "f2", label: "host", type: "STRING", value: "api.example.com", section: { label: "Net" } },
  ],
});

describe("OpCli.listItems", () => {
  const runner = () =>
    new FakeRunner((argv) =>
      argv[2] === "list"
        ? { stdout: JSON.stringify([{ id: "i1", title: "Token GitHub" }]) }
        : { stdout: ITEM_JSON },
    );

  it("lists labels, sections and types, skips empty and OTP fields, and drops values", async () => {
    const r = runner();
    const items = await new OpCli(r, {}).listItems("AgentBox");
    expect(r.runs[0]?.argv).toEqual([
      "op",
      "item",
      "list",
      "--vault",
      "AgentBox",
      "--format",
      "json",
    ]);
    expect(r.runs[1]?.argv).toEqual([
      "op",
      "item",
      "get",
      "i1",
      "--vault",
      "AgentBox",
      "--format",
      "json",
    ]);
    expect(items).toEqual([
      {
        id: "i1",
        title: "Token GitHub",
        fields: [
          { id: "credential", label: "credential", type: "CONCEALED" },
          { id: "f2", label: "host", type: "STRING", section: "Net" },
        ],
      },
    ]);
    expect(JSON.stringify(items)).not.toContain(SECRET);
    expect(JSON.stringify(items)).not.toContain("api.example.com");
  });

  it.each([
    [{ code: null, failedToStart: true }, "secrets_unavailable"],
    [{ code: 1, stderr: "[ERROR] You are not currently signed in." }, "secrets_locked"],
    [{ code: 1, stderr: "[ERROR] vault not found" }, "secrets_unavailable"],
  ] as const)("maps a failure to its code", async (result, code) => {
    const op = new OpCli(new FakeRunner(() => ({ ...result, stdout: SECRET })), {});
    const err = await op.listItems("v").catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(code);
    expect((err as ApiError).message).not.toContain(SECRET);
  });

  it("never echoes unparseable output", async () => {
    const op = new OpCli(
      new FakeRunner((argv) => ({ stdout: argv[2] === "list" ? '[{"id":"i1"}]' : `{${SECRET}` })),
      {},
    );
    const err = await op.listItems("v").catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("secrets_unavailable");
    expect((err as ApiError).message).not.toContain(SECRET);
  });
});

class FakeOp implements OpClient {
  listed: string[] = [];
  items: Record<string, OpItemInfo[]> = {};
  constructor(
    private state: OpStatus = { installed: true, version: "2", signedIn: true, mode: "desktop" },
  ) {}
  async status() {
    return this.state;
  }
  async read(): Promise<string> {
    throw new Error("not used");
  }
  async listItems(vault: string) {
    this.listed.push(vault);
    const found = this.items[vault];
    if (!found) throw new ApiError("secrets_unavailable", `Can't list vault ${vault}: missing`);
    return found;
  }
}

describe("SecretsService.available", () => {
  const item: OpItemInfo = {
    id: "i1",
    title: "Token GitHub",
    fields: [
      { id: "credential", label: "credential", type: "CONCEALED" },
      { id: "f2", label: "host", type: "STRING", section: "Net" },
      { id: "f3", label: "a/b", type: "STRING" },
    ],
  };

  function make(op: FakeOp, vaults: string[] = [], global: SecretRef[] = [], project: SecretRef[] = []) {
    let t = 1_000;
    const settings: GlobalSettings = {
      ...defaultConfig(),
      secretRefs: global,
      secretVaults: vaults,
    };
    const svc = new SecretsService({
      op,
      settings: () => settings,
      projectRefs: async () => project,
      listProjects: async () => [{ projectId: "p-00000000", refs: project }],
      now: () => t,
    });
    return { svc, advance: (ms: number) => (t += ms) };
  }

  it("proposes names and writes references", async () => {
    const op = new FakeOp();
    op.items["Mine"] = [item];
    const r = await make(op, ["Mine"]).svc.available();
    expect(r.candidates.map((c) => [c.ref, c.suggestedName])).toEqual([
      ["op://Mine/Token GitHub/credential", "TOKEN_GITHUB_CREDENTIAL"],
      ["op://Mine/Token GitHub/Net/host", "TOKEN_GITHUB_HOST"],
      ["op://Mine/Token GitHub/f3", "TOKEN_GITHUB_A_B"],
    ]);
    expect(JSON.stringify(r)).not.toMatch(/value/i);
  });

  it("chooses the vaults from the setting, then the references, then AgentBox", async () => {
    const op = new FakeOp();
    op.items["Mine"] = [item];
    op.items["Dev"] = [];
    op.items["Ops"] = [];
    op.items["AgentBox"] = [];
    expect((await make(op, ["Mine"]).svc.available()).vaults).toEqual(["Mine"]);
    const fromRefs = make(op, [], [{ name: "Y", ref: "op://Ops/y/z" }], [
      { name: "X", ref: "op://Dev/x/y" },
    ]);
    expect((await fromRefs.svc.available()).vaults).toEqual(["Dev", "Ops"]);
    expect((await make(op).svc.available()).vaults).toEqual(["AgentBox"]);
  });

  it("caches for 30 seconds and refresh bypasses the cache", async () => {
    const op = new FakeOp();
    op.items["Mine"] = [item];
    const { svc, advance } = make(op, ["Mine"]);
    await svc.available();
    await svc.available();
    expect(op.listed).toHaveLength(1);
    await svc.available(true);
    expect(op.listed).toHaveLength(2);
    advance(AVAILABLE_CACHE_TTL_MS + 1);
    await svc.available();
    expect(op.listed).toHaveLength(3);
  });

  it("reports a failing vault and throws when every vault fails", async () => {
    const op = new FakeOp();
    op.items["Good"] = [item];
    const some = await make(op, ["Good", "Bad"]).svc.available();
    expect(some.vaultErrors.map((e) => e.vault)).toEqual(["Bad"]);
    expect(some.candidates).toHaveLength(3);
    await expect(make(op, ["Bad"]).svc.available()).rejects.toMatchObject({
      code: "secrets_unavailable",
    });
  });

  it("refuses when op is missing or locked", async () => {
    const locked = new FakeOp({ installed: true, version: "2", signedIn: false, mode: "desktop" });
    await expect(make(locked, ["Mine"]).svc.available()).rejects.toMatchObject({
      code: "secrets_locked",
    });
    const missing = new FakeOp({ installed: false, version: null, signedIn: false, mode: "none" });
    await expect(make(missing, ["Mine"]).svc.available()).rejects.toMatchObject({
      code: "secrets_unavailable",
    });
    expect(locked.listed).toEqual([]);
  });

  it("never returns a field value, end to end through the op wrapper", async () => {
    const runner = new FakeRunner((argv) => {
      if (argv[1] === "--version") return { stdout: "2.30.0" };
      if (argv[1] === "whoami") return { stdout: "{}" };
      if (argv[2] === "list") return { stdout: JSON.stringify([{ id: "i1", title: "Token GitHub" }]) };
      return { stdout: ITEM_JSON };
    });
    const settings: GlobalSettings = { ...defaultConfig(), secretVaults: ["Mine"] };
    const svc = new SecretsService({
      op: new OpCli(runner, {}),
      settings: () => settings,
      projectRefs: async () => [],
      listProjects: async () => [],
    });
    const result = await svc.available(true);
    expect(result.candidates).toHaveLength(2);
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("api.example.com");
    expect(text).not.toContain("otpauth");
  });

  it("suggests valid names", () => {
    expect(suggestSecretName("Token GitHub", "credential")).toBe("TOKEN_GITHUB_CREDENTIAL");
    expect(suggestSecretName("1pass", "x-y")).toBe("_1PASS_X_Y");
    expect(suggestSecretName("--", "")).toBe("SECRET");
  });
});
