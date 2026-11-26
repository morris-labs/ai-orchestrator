// Runs each CLI adapter end to end against the stand-ins in tools/mock-clis.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageSampleSchema, type Vendor } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { CopilotAdapter } from "../../src/adapters/copilot.js";
import { VendorFindingsOutputSchema } from "../../src/adapters/output.js";
import { isRetryable } from "../../src/adapters/retry.js";
import { AdapterError, type CliVendorAdapter } from "../../src/adapters/types.js";
import { MOCK_BIN } from "./helpers.js";
import { tempDir } from "../tmp.js";

const finding = {
  severity: "P1",
  title: "Unbounded retry",
  file: "src/net.ts",
  lines: [5, 9],
  failure_case: "A dead host loops forever.",
  category: "resource-handling",
  introduced: true,
};

const scenario = {
  responses: [
    {
      match: "FIND",
      times: 1,
      output: { findings: [finding] },
      tokens: { input: 5000, output: 300 },
      rateLimits: { primary: 35, secondary: 60 },
      premiumRequests: 1,
      model: "gemini-3-pro",
    },
    { match: "MORE", output: { findings: [] } },
    { match: "LIMIT", error: "usage_limit" },
    { match: "RATE", error: "rate_limit" },
    { match: "AUTH", error: "auth" },
    { match: "SLOW", delayMs: 5000 },
    { match: "FIX", output: { done: true }, writeFiles: { "fixed.txt": "fixed\n" } },
    { match: "FLAKY", times: 1, text: "I could not decide." },
    { match: "FLAKY", output: { findings: [] } },
    { match: "PROSE", text: `Here you go:\n${JSON.stringify({ findings: [finding] })}\nThanks.` },
  ],
};

function setup() {
  const dir = tempDir("aio-mockcli-");
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify({ codex: scenario, copilot: scenario, claude: scenario }));
  const log = join(dir, "calls.jsonl");
  const codexHome = join(dir, "codex-home");
  const env = {
    MOCK_CLI_SCENARIO: file,
    MOCK_CLI_LOG: log,
    CODEX_HOME: codexHome,
    // A folder of the test's own, so no adapter reads the account folder
    // that the environment might name.
    CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
    ANTHROPIC_API_KEY: undefined,
  };
  const options = { env, account: "user@example.com" };
  const adapters: Record<Vendor, CliVendorAdapter> = {
    claude: new ClaudeAdapter({ ...options, command: join(MOCK_BIN, "claude"), bare: false }),
    codex: new CodexAdapter({ ...options, command: join(MOCK_BIN, "codex"), codexHome }),
    copilot: new CopilotAdapter({ ...options, command: join(MOCK_BIN, "copilot") }),
  };
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            cli: string;
            argv: string[];
            prompt: string;
            sandbox?: string;
            writable?: boolean;
            readOnly?: boolean;
          },
      );
  return { dir, env, adapters, calls };
}

const request = (dir: string, prompt: string) => ({
  prompt,
  cwd: dir,
  tools: "read-only" as const,
  timeoutMs: 20_000,
  outputSchema: VendorFindingsOutputSchema,
});

describe.each(["claude", "codex", "copilot"] as const)(
  "%s adapter against the mock CLI",
  (vendor) => {
    it("reviews, then continues the same session", async () => {
      const { dir, adapters, calls } = setup();
      const adapter = adapters[vendor];
      const first = await adapter.review(request(dir, "FIND bugs"));
      expect(first.output.findings).toEqual([
        expect.objectContaining({ title: "Unbounded retry", verdict: "pending" }),
      ]);
      expect(first.sessionId).toBeTruthy();
      expect(first.tokens.output).toBeGreaterThan(0);
      for (const sample of first.usage) UsageSampleSchema.parse(sample);
      if (vendor === "claude") expect(first.usage.map((s) => s.window)).toEqual(["5h", "7d"]);
      if (vendor === "codex")
        expect(first.usage).toEqual([
          expect.objectContaining({ window: "5h", utilization: 0.35 }),
          expect.objectContaining({ window: "7d", utilization: 0.6 }),
        ]);
      if (vendor === "copilot") {
        expect(first.premiumRequests).toBe(1);
        expect(first.model).toBe("gemini-3-pro");
      }

      const more = await adapter.continueReview({
        ...request(dir, "MORE please"),
        sessionId: first.sessionId!,
      });
      expect(more.output.findings).toEqual([]);
      expect(more.sessionId).toBe(first.sessionId);
      const log = calls();
      expect(log).toHaveLength(2);
      expect(log[1]!.argv.join(" ")).toContain(first.sessionId!);
      if (vendor === "codex") expect(log[0]!.sandbox).toBe("danger-full-access");
      if (vendor === "copilot") expect(log[0]!.writable).toBe(false);
      if (vendor === "claude") expect(log[0]!.readOnly).toBe(true);
    });

    it("resumes a session for a write call that names it, and starts fresh for one that doesn't", async () => {
      const { dir, adapters, calls } = setup();
      const adapter = adapters[vendor];
      const write = (prompt: string) => ({
        ...request(dir, prompt),
        tools: "write" as const,
        outputSchema: z.object({ done: z.boolean() }),
      });
      const first = await adapter.fix(write("FIX it"));
      expect(first.sessionId).toBeTruthy();
      const again = await adapter.fix({ ...write("FIX it again"), sessionId: first.sessionId! });
      expect(again.sessionId).toBe(first.sessionId);
      const fresh = await adapter.fix(write("FIX it fresh"));
      expect(fresh.sessionId).not.toBe(first.sessionId);
      const log = calls();
      expect(log[1]!.argv.join(" ")).toContain(first.sessionId!);
      expect(log[2]!.argv.join(" ")).not.toContain(first.sessionId!);
    });

    it("reports a usage limit", async () => {
      const { dir, adapters } = setup();
      const err = (await adapters[vendor]
        .review(request(dir, "LIMIT"))
        .catch((e: unknown) => e)) as AdapterError;
      expect(err).toBeInstanceOf(AdapterError);
      expect(err.kind).toBe("limit");
      expect(adapters[vendor].detectLimit(err)?.kind).toBe("usage_limit");
    });

    it("reports a rate limit", async () => {
      const { dir, adapters } = setup();
      const err = (await adapters[vendor]
        .review(request(dir, "RATE"))
        .catch((e: unknown) => e)) as AdapterError;
      expect(err.kind).toBe("limit");
      expect(err.limit?.kind).toBe("rate_limit");
    });

    it("reports a missing sign-in", async () => {
      const { dir, adapters } = setup();
      await expect(adapters[vendor].review(request(dir, "AUTH"))).rejects.toMatchObject({
        kind: "auth",
      });
    });

    it("times out and kills the CLI", async () => {
      const { dir, adapters } = setup();
      const started = Date.now();
      await expect(
        adapters[vendor].review({ ...request(dir, "SLOW"), timeoutMs: 300 }),
      ).rejects.toMatchObject({ kind: "timeout" });
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it("writes files in a fix", async () => {
      const { dir, adapters } = setup();
      const result = await adapters[vendor].fix({
        ...request(dir, "FIX it"),
        tools: "write",
        outputSchema: z.object({ done: z.boolean() }),
      });
      expect(result.output.done).toBe(true);
      expect(readFileSync(join(dir, "fixed.txt"), "utf8")).toBe("fixed\n");
    });

    it("extracts JSON from prose", async () => {
      const { dir, adapters } = setup();
      const result = await adapters[vendor].review(request(dir, "PROSE"));
      expect(result.output.findings).toHaveLength(1);
    });

    it("succeeds on the retry after an unusable answer", async () => {
      const { dir, adapters } = setup();
      let attempts = 0;
      const attempt = () => {
        attempts += 1;
        return adapters[vendor].review(request(dir, "FLAKY"));
      };
      const result = await attempt().catch((error: unknown) => {
        expect(isRetryable(error)).toBe(true);
        return attempt();
      });
      expect(attempts).toBe(2);
      expect(result.output.findings).toEqual([]);
    });

    it("reports health", async () => {
      const { adapters } = setup();
      expect(await adapters[vendor].health()).toMatchObject({
        available: true,
        version: expect.stringContaining("mock"),
      });
    });
  },
);

describe("codex resume usage", () => {
  it("reports only the resumed turn's tokens, not the thread's total", async () => {
    const { dir, adapters } = setup();
    const first = await adapters.codex.review(request(dir, "FIND bugs"));
    expect(first.tokens).toMatchObject({ input: 5000, output: 300 });
    const more = await adapters.codex.continueReview({
      ...request(dir, "MORE please"),
      sessionId: first.sessionId!,
    });
    // The mock reports the thread's total (6200 and 380) on `turn.completed`,
    // as Codex does, so the adapter must subtract the earlier turns.
    expect(more.tokens).toMatchObject({ input: 1200, output: 80, fresh: 1200, cacheRead: 0 });
  });
});

describe("claude resume usage", () => {
  it("reports only the resumed turn's tokens, not the session's total", async () => {
    const { dir, adapters } = setup();
    const first = await adapters.claude.review(request(dir, "FIND bugs"));
    expect(first.tokens).toMatchObject({ input: 5000, output: 300 });
    const more = await adapters.claude.continueReview({
      ...request(dir, "MORE please"),
      sessionId: first.sessionId!,
    });
    // The mock reports the session's total (6500 and 390) in `modelUsage`,
    // as Claude Code does, so the adapter must subtract the earlier turns.
    expect(more.tokens).toMatchObject({ input: 1500, output: 90, fresh: 1500, cacheRead: 0 });
  });

  it("reads the earlier total from the session's transcript after a restart", async () => {
    const { dir, env, adapters } = setup();
    const first = await adapters.claude.review(request(dir, "FIND bugs"));
    // A new adapter, as after an engine restart, knows no earlier total, so
    // it reads the transcript that Claude Code keeps in the config folder.
    const config = env.CLAUDE_CONFIG_DIR;
    const folder = join(config, "projects", "-work-repo");
    mkdirSync(folder, { recursive: true });
    const line = (id: string, usage: Record<string, number>) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-01T10:00:00.000Z",
        message: { id, model: "claude-opus-5-5", usage },
      });
    writeFileSync(
      join(folder, `${first.sessionId!}.jsonl`),
      [
        line("msg_1", { input_tokens: 3000, output_tokens: 100 }),
        // Claude Code writes a line per content block; each response counts once.
        line("msg_1", { input_tokens: 3000, output_tokens: 100 }),
        line("msg_2", { input_tokens: 2000, output_tokens: 200 }),
      ].join("\n") + "\n",
    );
    const restarted = new ClaudeAdapter({
      env,
      account: "user@example.com",
      command: join(MOCK_BIN, "claude"),
      bare: false,
    });
    const more = await restarted.continueReview({
      ...request(dir, "MORE please"),
      sessionId: first.sessionId!,
    });
    expect(more.tokens).toMatchObject({ input: 1500, output: 90 });
  });
});

describe("claude usage of a failed call", () => {
  it("puts the tokens a call spent before it failed on the error", async () => {
    const { dir, adapters } = setup();
    // The first FLAKY answer is prose, which the schema rejects.
    const error = await adapters.claude.review(request(dir, "FLAKY")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).tokens).toMatchObject({ input: 1500, output: 90 });
  });
});

describe("mock CLI state lock", () => {
  it("breaks a lock that a killed mock left behind", async () => {
    const { dir, adapters } = setup();
    // A pid that has exited, as a mock killed while holding the lock leaves.
    const deadPid = spawnSync("true").pid;
    const lock = join(dir, "scenario.json.state.json.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(deadPid));
    const started = Date.now();
    const result = await adapters.codex.review(request(dir, "FIND bugs"));
    expect(result.output.findings).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(lock)).toBe(false);
  });

  it("breaks an old lock that has no pid file", async () => {
    const { dir, adapters } = setup();
    const lock = join(dir, "scenario.json.state.json.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const result = await adapters.codex.review(request(dir, "FIND bugs"));
    expect(result.output.findings).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("missing CLI", () => {
  it("reports unavailable", async () => {
    const adapter = new CodexAdapter({ command: "aio-no-such-codex" });
    expect((await adapter.health()).available).toBe(false);
    await expect(adapter.review(request(tmpdir(), "x"))).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
