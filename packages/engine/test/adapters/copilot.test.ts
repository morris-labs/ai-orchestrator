import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CopilotAdapter,
  copilotErrorLimit,
  count,
  noAnswerMessage,
  parseCopilotJson,
  parseCopilotText,
} from "../../src/adapters/copilot.js";
import { parseStructuredText, VendorFindingsOutputSchema } from "../../src/adapters/output.js";
import type { AdapterError, CliRequest } from "../../src/adapters/types.js";
import { fixture, fixturePath } from "./helpers.js";
import { tempDir } from "../tmp.js";
import { setCredentialSource } from "../../src/process/credentials.js";
import { BrokerClient } from "../../src/secrets/broker-client.js";
import { startFakeBroker } from "../secrets/fake-broker.js";

const now = new Date("2026-10-28T09:00:00Z");
const base: CliRequest<unknown> = {
  prompt: "Review it.",
  cwd: "/w",
  tools: "read-only",
  timeoutMs: 1,
  outputSchema: z.object({ ok: z.boolean() }),
};

describe("parseCopilotJson", () => {
  it("reads the session, model, answer, and premium requests", () => {
    const s = parseCopilotJson(fixture("copilot-review.jsonl"));
    expect(s).toMatchObject({
      sessionId: "5f0c3a52-8d7e-4c1b-9a51-3a0b6f2e9d11",
      model: "gemini-3-pro",
      premiumRequests: 5.4,
      tokens: { input: 0, output: 240 },
      error: null,
    });
    const out = parseStructuredText("copilot", VendorFindingsOutputSchema, s.text!, "");
    expect(out.findings[0]?.file).toBe("src/cache.ts");
  });

  it("prefers assistant.usage tokens and the reported premium-request total", () => {
    const stream = [
      { type: "assistant.message", data: { content: "{}", outputTokens: 9 } },
      {
        type: "assistant.usage",
        data: { inputTokens: 100, outputTokens: 10, cost: 1, model: "gpt-5.1" },
      },
      { type: "session.shutdown", data: { totalPremiumRequests: 2 } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const s = parseCopilotJson(stream);
    expect(s).toMatchObject({
      tokens: { input: 100, output: 10 },
      premiumRequests: 2,
      model: "gpt-5.1",
    });
    expect(s).not.toHaveProperty("costUsd");
  });

  it("splits input into fresh input and cache reads and writes when the CLI reports them", () => {
    const stream = JSON.stringify({
      type: "assistant.usage",
      data: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 70, cacheWriteTokens: 20 },
    });
    expect(parseCopilotJson(stream).tokens).toEqual({
      input: 100,
      output: 10,
      fresh: 10,
      cacheWrite: 20,
      cacheRead: 70,
    });
  });

  it("adds cache counts to an input that leaves them out", () => {
    const stream = JSON.stringify({
      type: "assistant.usage",
      data: { inputTokens: 8, outputTokens: 10, cacheReadTokens: 70, cacheWriteTokens: 18 },
    });
    expect(parseCopilotJson(stream).tokens).toEqual({
      input: 96,
      output: 10,
      fresh: 8,
      cacheWrite: 18,
      cacheRead: 70,
    });
  });

  it("adds cache counts to a Claude model's input even when they're smaller", () => {
    const stream = JSON.stringify({
      type: "assistant.usage",
      data: {
        model: "claude-sonnet-4.5",
        inputTokens: 5000,
        outputTokens: 10,
        cacheReadTokens: 1000,
      },
    });
    expect(parseCopilotJson(stream).tokens).toMatchObject({
      input: 6000,
      fresh: 5000,
      cacheRead: 1000,
    });
  });

  it("counts assistant.usage cost as a premium-request multiplier, not dollars", async () => {
    const stream = [
      { type: "assistant.message", data: { content: '{"ok":true}', outputTokens: 9 } },
      { type: "assistant.usage", data: { inputTokens: 100, outputTokens: 5, cost: 1 } },
      { type: "assistant.usage", data: { inputTokens: 50, outputTokens: 4, cost: 0.33 } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(parseCopilotJson(stream).premiumRequests).toBe(1.33);

    const dir = tempDir("copilot-cost-");
    const cli = join(dir, "copilot");
    const out = join(dir, "stream.jsonl");
    writeFileSync(out, `${stream}\n`);
    writeFileSync(cli, `#!/bin/sh\ncat '${out}'\n`, { mode: 0o755 });
    const result = await new CopilotAdapter({ command: cli }).review({
      ...base,
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(result.premiumRequests).toBe(1.33);
    // 1.33 premium requests at $0.04 each, not $1.33.
    expect(result.costUsd).toBeCloseTo(0.0532, 6);
  });

  it("reads a quota error", () => {
    const s = parseCopilotJson(fixture("copilot-quota.jsonl"));
    expect(s.error).toMatchObject({ type: "quota", code: "quota_exceeded" });
    expect(copilotErrorLimit(s.error!, now)).toMatchObject({ kind: "usage_limit" });
  });

  it("falls back to text parsing without JSON lines", () => {
    expect(parseCopilotJson(fixture("copilot-legacy.stdout.txt")).text?.trim()).toBe(
      '{"findings":[]}',
    );
  });
});

describe("parseCopilotJson tool errors", () => {
  it("collects tool calls that report success false", () => {
    const stream = [
      { type: "tool.execution_complete", data: { toolCallId: "1", success: true } },
      {
        type: "tool.execution_complete",
        data: { toolCallId: "2", success: false, error: { message: "Permission denied" } },
      },
      { type: "assistant.message", data: { content: "{}" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(parseCopilotJson(stream).toolErrors).toEqual(["Permission denied"]);
  });
});

describe("parseCopilotText", () => {
  it("splits the legacy exit summary from the answer", () => {
    const s = parseCopilotText(fixture("copilot-legacy.stdout.txt"));
    expect(s.text?.trim()).toBe('{"findings":[]}');
    expect(s.premiumRequests).toBe(1);
    expect(s.tokens).toEqual({ input: 56000, output: 435 });
  });

  it("reads the AI-credits summary from stderr", () => {
    const s = parseCopilotText(
      fixture("copilot-credits.stdout.txt"),
      fixture("copilot-credits.stderr.txt"),
    );
    expect(s).toMatchObject({
      aiCredits: 7.02,
      tokens: { input: 51000, output: 118 },
      sessionId: "5f0c3a52-8d7e-4c1b-9a51-3a0b6f2e9d13",
    });
  });

  it("reports an error line when there is no answer", () => {
    expect(parseCopilotText("", "Error: something broke").error?.message).toBe(
      "Error: something broke",
    );
  });
});

describe("copilotErrorLimit", () => {
  it("maps rate limits and skips billing setup", () => {
    expect(
      copilotErrorLimit({ type: "rate_limit", code: "user_weekly_rate_limited", message: "" }, now)
        ?.kind,
    ).toBe("usage_limit");
    const rate = copilotErrorLimit(
      { type: "rate_limit", code: "rate_limited", message: "Try again in 2 minutes" },
      now,
    );
    expect(rate).toMatchObject({ kind: "rate_limit", resetAt: "2026-10-28T09:02:00.000Z" });
    expect(
      copilotErrorLimit({ type: "quota", code: "billing_not_configured", message: "x" }, now),
    ).toBeNull();
    expect(copilotErrorLimit({ type: "internal", code: null, message: "boom" }, now)).toBeNull();
  });
});

describe("CopilotAdapter", () => {
  const adapter = new CopilotAdapter();

  it("asks for JSON matching the schema in the prompt", () => {
    const prompt = adapter.buildPrompt({ ...base, systemPrompt: "Be thorough." });
    expect(prompt.startsWith("Be thorough.\n\nReview it.")).toBe(true);
    expect(prompt).toMatch(/exactly one JSON value/);
    expect(prompt).toContain('"ok"');
  });

  it("builds read-only args with automatic model selection and a fixed session id", () => {
    const args = adapter.buildArgs(base, "/tmp/x/prompt.md", "sid");
    expect(args[0]).toBe("-p");
    expect(args[1]).toMatch(/^Read the file \/tmp\/x\/prompt\.md /);
    expect(args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "json",
        "--model",
        "auto",
        "--session-id",
        "sid",
        "--no-ask-user",
      ]),
    );
    expect(args).toEqual(
      expect.arrayContaining(["--allow-tool", "shell(git blame:*)", "--deny-tool", "write"]),
    );
    // Commands that can write a file through an option are never allowed.
    expect(args.filter((a) => /git (diff|log|show)/.test(a))).toEqual([]);
    expect(args).toEqual(expect.arrayContaining(["--deny-tool", "write"]));
    expect(args).not.toContain("--allow-all-tools");
  });

  it("builds a write continuation", () => {
    const args = adapter.buildArgs(
      { ...base, tools: "write", sessionId: "s1", model: "gpt-5.1", effort: "low" },
      "/tmp/x/prompt.md",
      "unused",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--allow-all-tools",
        "--resume=s1",
        "--model",
        "gpt-5.1",
        "--effort",
        "low",
      ]),
    );
    expect(args).not.toContain("--session-id");
  });

  it("adds each extra directory with --add-dir", () => {
    const args = adapter.buildArgs(
      { ...base, addDirs: ["/base", "/scratch"] },
      "/tmp/x/prompt.md",
      "sid",
    );
    expect(args.join(" ")).toContain("--add-dir /base --add-dir /scratch");
  });

  it("returns the AI credits the exit summary reports", async () => {
    const dir = tempDir("copilot-credits-");
    const cli = join(dir, "copilot");
    writeFileSync(
      cli,
      `#!/bin/sh\ncat '${fixturePath("copilot-credits.stdout.txt")}'\ncat '${fixturePath("copilot-credits.stderr.txt")}' >&2\n`,
      { mode: 0o755 },
    );
    const credits = new CopilotAdapter({ command: cli, outputFormat: "text" });
    const out = await credits.review({
      ...base,
      cwd: dir,
      timeoutMs: 10_000,
      outputSchema: VendorFindingsOutputSchema,
    });
    expect(out.aiCredits).toBe(7.02);
    expect(out.output).toEqual({ findings: [] });
  });

  it("keeps the end of stderr when Copilot returns no answer", async () => {
    const dir = tempDir("copilot-no-answer-");
    const cli = join(dir, "copilot");
    writeFileSync(
      cli,
      [
        "#!/bin/sh",
        `echo '{"type":"session.start","data":{"sessionId":"s1"}}'`,
        "echo 'Error: Access denied by policy settings' >&2",
        `cat '${fixturePath("copilot-credits.stderr.txt")}' >&2`,
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const err = (await new CopilotAdapter({ command: cli })
      .review({ ...base, cwd: dir, timeoutMs: 10_000 })
      .catch((e: unknown) => e)) as AdapterError;
    expect(err.message).toMatch(
      /Copilot returned no answer\. Its error output ends with: Error: Access denied by policy settings$/,
    );
    expect(noAnswerMessage("")).toBe("Copilot returned no answer.");
    expect(noAnswerMessage(`${"x".repeat(1000)}\nError: denied`)).toMatch(
      /^Copilot returned no answer\. Its error output ends with: \.\.\.x+\nError: denied$/,
    );
  });

  it("never hands Copilot a classic token and says how to sign in", async () => {
    const dir = tempDir("copilot-token-");
    const cli = join(dir, "copilot");
    const seen = join(dir, "seen.txt");
    writeFileSync(
      cli,
      [
        "#!/bin/sh",
        `printf '%s|%s|%s' "$COPILOT_GITHUB_TOKEN" "$GH_TOKEN" "$GITHUB_TOKEN" > '${seen}'`,
        'case "$GH_TOKEN$GITHUB_TOKEN$COPILOT_GITHUB_TOKEN" in',
        '  ghp_*) echo "Error: Classic Personal Access Tokens (ghp_) are not supported by Copilot." >&2; exit 1;;',
        "esac",
        'echo "Error: No authentication information found." >&2',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const withClassic = new CopilotAdapter({
      command: cli,
      outputFormat: "text",
      env: {
        GH_TOKEN: "ghp_classic0123",
        GITHUB_TOKEN: undefined,
        COPILOT_GITHUB_TOKEN: undefined,
      },
    });
    const err = (await withClassic
      .review({ ...base, cwd: dir, timeoutMs: 10_000 })
      .catch((e: unknown) => e)) as AdapterError;
    expect(readFileSync(seen, "utf8")).toBe("||");
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/Copilot can't sign in/);
    expect(err.message).toMatch(/COPILOT_GITHUB_TOKEN to a fine-grained token/);
    expect(err.message).not.toContain("ghp_classic0123");

    const fineGrained = new CopilotAdapter({
      command: cli,
      outputFormat: "text",
      env: {
        GH_TOKEN: "ghp_classic0123",
        GITHUB_TOKEN: undefined,
        COPILOT_GITHUB_TOKEN: "github_pat_fine",
      },
    });
    await fineGrained.review({ ...base, cwd: dir, timeoutMs: 10_000 }).catch(() => undefined);
    expect(readFileSync(seen, "utf8")).toBe("github_pat_fine||");

    // The same holds for a token that comes from the secrets broker.
    const broker = await startFakeBroker({ GH_TOKEN: "ghp_classic0123", DATABASE_URL: "x" });
    setCredentialSource(new BrokerClient({ socketPath: broker.socketPath }));
    try {
      const brokered = new CopilotAdapter({
        command: cli,
        outputFormat: "text",
        env: { GITHUB_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined },
      });
      const fromBroker = (await brokered
        .review({ ...base, cwd: dir, timeoutMs: 10_000 })
        .catch((e: unknown) => e)) as AdapterError;
      expect(readFileSync(seen, "utf8")).toBe("||");
      expect(broker.reads.map((r) => r.names)).toEqual([["GH_TOKEN"]]);
      expect(fromBroker.message).toMatch(/GH_TOKEN holds a classic personal access token/);
      expect(fromBroker.message).not.toContain("ghp_classic0123");
    } finally {
      setCredentialSource(null);
      await broker.close();
    }
  });

  it("points at the prompt file and lets a read-only call read it", () => {
    const args = adapter.buildArgs(base, "/tmp/x/prompt.md", "sid");
    expect(args[1]).toMatch(/Read the file \/tmp\/x\/prompt.md/);
    expect(args).toEqual(expect.arrayContaining(["--add-dir", "/tmp/x", "read(/tmp/x/prompt.md)"]));
  });

  it("never puts the prompt on the command line, however short", async () => {
    const dir = tempDir("copilot-argv-");
    const cli = join(dir, "copilot");
    const seen = join(dir, "seen.txt");
    writeFileSync(
      cli,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > '${seen}'`,
        'file=$(printf "%s" "$2" | sed -n "s/^Read the file \\([^ ]*\\) and follow.*/\\1/p")',
        `stat -c '%a' "$file" "$(dirname "$file")" >> '${seen}'`,
        `cat "$file" >> '${seen}'`,
        "echo '{\"ok\":true}'",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const copilot = new CopilotAdapter({ command: cli, outputFormat: "text" });
    const out = await copilot.review({
      ...base,
      prompt: "SYNTHETIC_SECRET_SOURCE diff",
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(out.output).toEqual({ ok: true });
    const lines = readFileSync(seen, "utf8").split("\n");
    const argv = lines.slice(0, lines.indexOf("600"));
    expect(argv.join("\n")).not.toContain("SYNTHETIC_SECRET_SOURCE");
    expect(lines).toEqual(expect.arrayContaining(["600", "700"]));
    expect(lines.join("\n")).toContain("SYNTHETIC_SECRET_SOURCE diff");
  });

  it("estimates premium requests with the automatic discount", () => {
    expect(adapter.estimatePremiumRequests("gpt-5.1", true)).toBe(2.7);
    expect(adapter.estimatePremiumRequests("gpt-5.1", false)).toBe(3);
    expect(adapter.estimatePremiumRequests("unknown-model", false)).toBe(1);
    expect(
      new CopilotAdapter({ premiumMultipliers: { x: 2 } }).estimatePremiumRequests("x", false),
    ).toBe(2);
  });

  it("counts abbreviated token figures", () => {
    expect(count("51.0k")).toBe(51000);
    expect(count("1.2M")).toBe(1_200_000);
    expect(count("118")).toBe(118);
    expect(count("x")).toBe(0);
  });
});
