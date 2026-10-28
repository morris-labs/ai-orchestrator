import {
  defaultConfig,
  type GlobalSettings,
  type OpStatus,
  type SecretRef,
} from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { ApiFailure } from "../../src/api/errors.js";
import { OpCli, type OpClient } from "../../src/secrets/op.js";
import { mergeSecretRefs, SecretsService } from "../../src/secrets/secrets-service.js";
import { FakeRunner } from "../setup/fake-runner.js";

const SECRET = "s3cr3t-value-never-shown";

describe("OpCli", () => {
  it("reports a missing op", async () => {
    const op = new OpCli(new FakeRunner(() => ({ code: null, failedToStart: true })), {});
    expect(await op.status()).toEqual({
      installed: false,
      version: null,
      signedIn: false,
      mode: "none",
    });
  });

  it("reports the desktop mode and sign-in state", async () => {
    const runner = new FakeRunner((argv) =>
      argv[1] === "--version" ? { stdout: "2.30.0\n" } : { code: 1, stderr: "not signed in" },
    );
    expect(await new OpCli(runner, {}).status()).toEqual({
      installed: true,
      version: "2.30.0",
      signedIn: false,
      mode: "desktop",
    });
    expect(runner.runs[1]?.argv).toEqual(["op", "whoami", "--format", "json"]);
  });

  it("reports the service account mode", async () => {
    const op = new OpCli(new FakeRunner(() => ({ stdout: "2.30.0" })), {
      OP_SERVICE_ACCOUNT_TOKEN: "x",
    });
    expect((await op.status()).mode).toBe("service_account");
  });

  it("reads a reference", async () => {
    const runner = new FakeRunner(() => ({ stdout: SECRET }));
    expect(await new OpCli(runner, {}).read("op://v/i/f")).toBe(SECRET);
    expect(runner.runs[0]?.argv).toEqual(["op", "read", "--no-newline", "op://v/i/f"]);
    expect(runner.runs[0]?.options.timeoutMs).toBe(30_000);
  });

  it.each([
    [{ code: null, failedToStart: true }, "secrets_unavailable"],
    [{ code: 1, stderr: "[ERROR] You are not currently signed in." }, "secrets_locked"],
    [{ code: 1, stderr: "[ERROR] could not find item i in vault v" }, "secrets_unavailable"],
  ] as const)("maps a failure to its code", async (result, code) => {
    const op = new OpCli(new FakeRunner(() => ({ ...result, stdout: SECRET })), {});
    const err = await op.read("op://v/i/f").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).code).toBe(code);
    expect((err as ApiFailure).message).not.toContain(SECRET);
  });
});

class FakeOp implements OpClient {
  reads: string[] = [];
  constructor(
    private state: OpStatus = { installed: true, version: "2", signedIn: true, mode: "desktop" },
    private values: Record<string, string> = {},
  ) {}
  async status() {
    return this.state;
  }
  async read(ref: string) {
    this.reads.push(ref);
    const v = this.values[ref];
    if (v === undefined)
      throw new ApiFailure("secrets_unavailable", `Can't resolve ${ref}: missing`);
    return v;
  }
}

const g = (name: string, ref: string): SecretRef => ({ name, ref });

function service(op: OpClient, global: SecretRef[], project: SecretRef[] = []) {
  const settings: GlobalSettings = { ...defaultConfig(), secretRefs: global };
  return new SecretsService({
    op,
    settings: () => settings,
    projectRefs: async (id) => {
      if (id !== "p-00000000") throw new ApiFailure("not_found", "no project");
      return project;
    },
    listProjects: async () => [{ projectId: "p-00000000", refs: project }],
  });
}

describe("SecretsService", () => {
  it("merges references with the project winning", () => {
    expect(
      mergeSecretRefs([g("A", "op://v/a/1"), g("B", "op://v/b/1")], [g("A", "op://v/a/2")]),
    ).toEqual([g("A", "op://v/a/2"), g("B", "op://v/b/1")]);
  });

  it("resolves the environment and reads each reference once per launch", async () => {
    const op = new FakeOp(undefined, { "op://v/a/2": "one", "op://v/b/1": "two" });
    const svc = service(
      op,
      [g("A", "op://v/a/1"), g("B", "op://v/b/1"), g("C", "op://v/b/1")],
      [g("A", "op://v/a/2")],
    );
    expect(await svc.resolveEnv("p-00000000")).toEqual({ A: "one", B: "two", C: "two" });
    expect(op.reads).toEqual(["op://v/a/2", "op://v/b/1"]);
    await svc.resolveEnv("p-00000000");
    expect(op.reads).toHaveLength(4);
  });

  it("skips op when there are no references", async () => {
    const svc = service(
      new FakeOp({ installed: false, version: null, signedIn: false, mode: "none" }),
      [],
    );
    expect(await svc.resolveEnv("p-00000000")).toEqual({});
  });

  it("refuses when op is missing or locked", async () => {
    const missing = service(
      new FakeOp({ installed: false, version: null, signedIn: false, mode: "none" }),
      [g("A", "op://v/a/1")],
    );
    await expect(missing.resolveEnv("p-00000000")).rejects.toMatchObject({
      code: "secrets_unavailable",
    });
    const locked = service(
      new FakeOp({ installed: true, version: "2", signedIn: false, mode: "desktop" }),
      [g("A", "op://v/a/1")],
    );
    await expect(locked.resolveEnv("p-00000000")).rejects.toMatchObject({ code: "secrets_locked" });
  });

  it("passes not_found for an unknown project", async () => {
    await expect(service(new FakeOp(), []).resolveEnv("nope")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("checks references without returning values", async () => {
    const svc = service(
      new FakeOp(undefined, { "op://v/a/1": SECRET }),
      [g("A", "op://v/a/1")],
      [g("B", "op://v/b/1")],
    );
    const result = await svc.check("p-00000000");
    expect(result.results).toEqual([
      { name: "A", ref: "op://v/a/1", scope: "global", ok: true, error: null },
      {
        name: "B",
        ref: "op://v/b/1",
        scope: "project",
        ok: false,
        error: "Can't resolve op://v/b/1: missing",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("checks report a locked op on every reference", async () => {
    const svc = service(
      new FakeOp({ installed: true, version: "2", signedIn: false, mode: "desktop" }),
      [g("A", "op://v/a/1")],
    );
    expect((await svc.check()).results[0]).toMatchObject({
      ok: false,
      error: "The 1Password CLI is not signed in.",
    });
  });

  it("builds the view", async () => {
    const view = await service(new FakeOp(), [g("A", "op://v/a/1")], [g("B", "op://v/b/1")]).view();
    expect(view.global).toEqual([g("A", "op://v/a/1")]);
    expect(view.projects).toEqual([{ projectId: "p-00000000", refs: [g("B", "op://v/b/1")] }]);
    expect(view.op.signedIn).toBe(true);
  });
});
