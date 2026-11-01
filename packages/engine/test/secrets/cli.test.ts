import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSecretArgs, resolveCommand, secretMain } from "../../src/secrets/cli.js";
import { tempDir } from "../tmp.js";
import { startFakeBroker, type FakeBroker } from "./fake-broker.js";

const brokers: FakeBroker[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.close();
});

async function run(
  argv: string[],
  values: Record<string, string> = { SYNTHETIC_TOKEN: "SYNTHETIC_value", SYNTHETIC_URL: "u" },
  fail?: Parameters<typeof startFakeBroker>[1],
) {
  const b = await startFakeBroker(values, fail);
  brokers.push(b);
  let stdout = "";
  let stderr = "";
  const ran: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const code = await secretMain(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env: { AIO_BROKER_SOCKET: b.socketPath, PATH: "/usr/bin", KEEP: "1" },
    run: async (command, args, env) => {
      ran.push({ command, args, env });
      return 7;
    },
  });
  return { code, stdout, stderr, ran, broker: b };
}

describe("parseSecretArgs", () => {
  it("parses each command", () => {
    expect(parseSecretArgs(["A"])).toEqual({ kind: "get", name: "A" });
    expect(parseSecretArgs(["get", "A"])).toEqual({ kind: "get", name: "A" });
    expect(parseSecretArgs(["list"])).toEqual({ kind: "list" });
    expect(parseSecretArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseSecretArgs(["run", "A,B", "C", "--", "make", "--", "x"])).toEqual({
      kind: "run",
      names: ["A", "B", "C"],
      command: "make",
      args: ["--", "x"],
    });
  });

  it.each([
    [[]],
    [["get"]],
    [["A", "B"]],
    [["bad-name"]],
    [["run", "A"]],
    [["run", "--", "x"]],
    [["run", "A", "--"]],
    [["list", "x"]],
  ])("refuses %j", (argv) => {
    expect(() => parseSecretArgs(argv)).toThrow();
  });
});

describe("secretMain", () => {
  it("prints one value without a newline", async () => {
    const r = await run(["SYNTHETIC_TOKEN"]);
    expect(r).toMatchObject({ code: 0, stdout: "SYNTHETIC_value", stderr: "" });
    expect(r.broker.reads[0]?.names).toEqual(["SYNTHETIC_TOKEN"]);
    expect(r.broker.reads[0]?.caller).toMatch(/^aio-secret get/);
  });

  it("lists names, never values", async () => {
    const r = await run(["list"]);
    expect(r).toMatchObject({ code: 0, stdout: "SYNTHETIC_TOKEN\nSYNTHETIC_URL\n" });
  });

  it("runs a command with the named secrets added to its environment", async () => {
    const r = await run(["run", "SYNTHETIC_TOKEN", "--", "make", "test", "--secret-arg"]);
    expect(r.code).toBe(7);
    expect(r.ran).toHaveLength(1);
    expect(r.ran[0]).toMatchObject({ command: "make", args: ["test", "--secret-arg"] });
    expect(r.ran[0]?.env).toMatchObject({ SYNTHETIC_TOKEN: "SYNTHETIC_value", KEEP: "1" });
    expect(r.ran[0]?.env.SYNTHETIC_URL).toBeUndefined();
    // The log gets the program's name, not its arguments.
    expect(r.broker.reads[0]?.caller).toMatch(/^aio-secret run make/);
    expect(r.broker.reads[0]?.caller).not.toContain("--secret-arg");
  });

  it("exits with a status for each kind of failure, and runs nothing", async () => {
    expect((await run(["MISSING"])).code).toBe(4);
    const unlisted = await run(["run", "MISSING", "--", "make"]);
    expect(unlisted.code).toBe(4);
    expect(unlisted.ran).toEqual([]);
    const locked = await run(
      ["SYNTHETIC_TOKEN"],
      {},
      {
        status: 503,
        code: "secrets_locked",
        message: "The 1Password CLI is not signed in.",
      },
    );
    expect(locked).toMatchObject({ code: 5, stdout: "" });
    expect(locked.stderr).toContain("not signed in");
    expect((await run(["bad-name"])).code).toBe(2);
    const gone = await secretMain(["list"], {
      stdout: () => undefined,
      stderr: () => undefined,
      env: { AIO_BROKER_SOCKET: path.join(tempDir("aio-gone-"), "broker.sock") },
    });
    expect(gone).toBe(3);
  });
});

describe("resolveCommand", () => {
  it("finds an executable on PATH, and takes a path as given", () => {
    const dir = tempDir("aio-path-");
    const tool = path.join(dir, "synthetic-tool");
    fs.writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "not-executable"), "", { mode: 0o644 });
    expect(resolveCommand("synthetic-tool", `relative:${dir}`)).toBe(tool);
    expect(resolveCommand("not-executable", dir)).toBeNull();
    expect(resolveCommand("./x", undefined)).toBe("./x");
  });
});
