import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/adapters/process.js";

const node = process.execPath;

describe("runProcess", () => {
  it("passes stdin, collects output, and splits lines", async () => {
    const seen: string[] = [];
    const result = await runProcess({
      command: node,
      args: [
        "-e",
        "process.stdin.on('data', d => process.stdout.write('a\\n' + String(d).toUpperCase() + '\\nlast')); process.stderr.write('warn')",
      ],
      cwd: process.cwd(),
      input: "hello",
      timeoutMs: 10_000,
      onLine: (line) => seen.push(line),
    });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual(["a", "HELLO", "last"]);
    expect(result.stderr).toBe("warn");
  });

  it("sets and removes environment variables", async () => {
    process.env.AGENTBOX_TEST_REMOVE = "1";
    const result = await runProcess({
      command: node,
      args: [
        "-e",
        "process.stdout.write(String(process.env.AGENTBOX_TEST_SET) + ',' + String(process.env.AGENTBOX_TEST_REMOVE))",
      ],
      cwd: process.cwd(),
      env: { AGENTBOX_TEST_SET: "yes", AGENTBOX_TEST_REMOVE: undefined },
      timeoutMs: 10_000,
    });
    delete process.env.AGENTBOX_TEST_REMOVE;
    expect(result.stdout).toBe("yes,undefined");
  });

  it("reports the exit code", async () => {
    const result = await runProcess({
      command: node,
      args: ["-e", "process.exit(3)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it("kills a process that runs past the timeout, children included", async () => {
    const started = Date.now();
    const result = await runProcess({
      command: "sh",
      args: ["-c", "sleep 30 & sleep 30"],
      cwd: process.cwd(),
      timeoutMs: 200,
      killGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const result = await runProcess({
      command: node,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 300,
      killGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  it("stops on abort", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runProcess({
      command: "sleep",
      args: ["30"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
  });

  it("returns at once for an already aborted signal", async () => {
    const result = await runProcess({
      command: "sleep",
      args: ["30"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: AbortSignal.abort(),
    });
    expect(result.cancelled).toBe(true);
    expect(result.durationMs).toBe(0);
  });

  it("reports a missing program as a spawn error", async () => {
    const result = await runProcess({
      command: "agentbox-no-such-cli",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.spawnError?.code).toBe("ENOENT");
  });
});
