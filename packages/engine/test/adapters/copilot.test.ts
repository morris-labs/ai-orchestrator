import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CopilotAdapter,
  copilotErrorLimit,
  count,
  parseCopilotJson,
  parseCopilotText,
} from "../../src/adapters/copilot.js";
import { parseStructuredText, VendorFindingsOutputSchema } from "../../src/adapters/output.js";
import type { CliRequest } from "../../src/adapters/types.js";
import { fixture, fixturePath } from "./helpers.js";

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

  it("prefers assistant.usage tokens and cost", () => {
    const stream = [
      { type: "assistant.message", data: { content: "{}", outputTokens: 9 } },
      {
        type: "assistant.usage",
        data: { inputTokens: 100, outputTokens: 10, cost: 0.02, model: "gpt-5.1" },
      },
      { type: "session.shutdown", data: { totalPremiumRequests: 2 } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(parseCopilotJson(stream)).toMatchObject({
      tokens: { input: 100, output: 10 },
      costUsd: 0.02,
      premiumRequests: 2,
      model: "gpt-5.1",
    });
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
    const args = adapter.buildArgs(base, "PROMPT", "sid");
    expect(args.slice(0, 2)).toEqual(["-p", "PROMPT"]);
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
      expect.arrayContaining(["--allow-tool", "shell(git diff:*)", "--deny-tool", "write"]),
    );
    expect(args).not.toContain("--allow-all-tools");
  });

  it("builds a write continuation", () => {
    const args = adapter.buildArgs(
      { ...base, tools: "write", sessionId: "s1", model: "gpt-5.1", effort: "low" },
      "P",
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
    const args = adapter.buildArgs({ ...base, addDirs: ["/base", "/scratch"] }, "P", "sid");
    expect(args.join(" ")).toContain("--add-dir /base --add-dir /scratch");
  });

  it("returns the AI credits the exit summary reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "copilot-credits-"));
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

  it("points at a prompt file for a long prompt", () => {
    const args = adapter.buildArgs(base, "P", "sid", "/tmp/x/prompt.md");
    expect(args[1]).toMatch(/Read the file \/tmp\/x\/prompt.md/);
    expect(args).toEqual(expect.arrayContaining(["--add-dir", "/tmp/x", "read(/tmp/x/prompt.md)"]));
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
