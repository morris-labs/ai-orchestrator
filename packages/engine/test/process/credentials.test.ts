import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../../src/adapters/process.js";
import { credentialsFor, setCredentialSource } from "../../src/process/credentials.js";
import { wantsCredential } from "../../src/process/env.js";
import { BrokerClient } from "../../src/secrets/broker-client.js";
import { startFakeBroker, type FakeBroker } from "../secrets/fake-broker.js";

const VALUES = {
  ANTHROPIC_API_KEY: "SYNTHETIC_anthropic",
  OPENAI_API_KEY: "SYNTHETIC_openai",
  GH_TOKEN: "SYNTHETIC_gh",
  DATABASE_URL: "SYNTHETIC_db",
};

const brokers: FakeBroker[] = [];
afterEach(async () => {
  setCredentialSource(null);
  for (const b of brokers.splice(0)) await b.close();
});

async function useBroker(fail?: Parameters<typeof startFakeBroker>[1]) {
  const b = await startFakeBroker(VALUES, fail);
  brokers.push(b);
  const warnings: string[] = [];
  setCredentialSource(new BrokerClient({ socketPath: b.socketPath }), (m, f) =>
    warnings.push(`${m} ${JSON.stringify(f)}`),
  );
  return { b, warnings };
}

describe("wantsCredential", () => {
  it("matches each profile's sign-in names only", () => {
    expect(wantsCredential("ANTHROPIC_API_KEY", "vendor:claude")).toBe(true);
    expect(wantsCredential("OPENAI_API_KEY", "vendor:claude")).toBe(false);
    expect(wantsCredential("GH_TOKEN", "github")).toBe(true);
    expect(wantsCredential("GH_TOKEN", "vendor:copilot")).toBe(true);
    expect(wantsCredential("DATABASE_URL", "github")).toBe(false);
    expect(wantsCredential("GH_TOKEN", "untrusted")).toBe(false);
  });
});

describe("credentialsFor", () => {
  it("returns nothing without a broker", async () => {
    expect(await credentialsFor("vendor:claude", "claude")).toEqual({});
  });

  it("asks only for the names the profile takes", async () => {
    const { b } = await useBroker();
    expect(await credentialsFor("vendor:claude", "claude")).toEqual({
      ANTHROPIC_API_KEY: "SYNTHETIC_anthropic",
    });
    expect(await credentialsFor("github", "git")).toEqual({ GH_TOKEN: "SYNTHETIC_gh" });
    expect(await credentialsFor("untrusted", "sh")).toEqual({});
    expect(b.reads.map((r) => r.names)).toEqual([["ANTHROPIC_API_KEY"], ["GH_TOKEN"]]);
    expect(b.reads[1]?.caller).toBe("engine github: git");
    // The untrusted profile doesn't even list names.
    expect(b.listCalls).toBe(2);
  });

  it("warns once and starts the child without credentials when the broker fails", async () => {
    const { warnings } = await useBroker({
      status: 503,
      code: "secrets_locked",
      message: "The 1Password CLI is not signed in.",
    });
    expect(await credentialsFor("vendor:codex", "codex")).toEqual({});
    expect(await credentialsFor("vendor:codex", "codex")).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not signed in");
  });

  it("puts a profile's credentials in its child's environment, and nothing in others", async () => {
    await useBroker();
    const script =
      "process.stdout.write([process.env.GH_TOKEN, process.env.DATABASE_URL, process.env.ANTHROPIC_API_KEY].join(','))";
    const github = await runProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      envProfile: "github",
      timeoutMs: 10_000,
    });
    expect(github.stdout).toBe("SYNTHETIC_gh,,");
    const untrusted = await runProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(untrusted.stdout).toBe(",,");
    // An explicit variable wins over a brokered one.
    const explicit = await runProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      envProfile: "github",
      env: { GH_TOKEN: "SYNTHETIC_explicit" },
      timeoutMs: 10_000,
    });
    expect(explicit.stdout).toBe("SYNTHETIC_explicit,,");
  });
});
