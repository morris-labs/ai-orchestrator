import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CEILINGS, UsageSampleSchema } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CodexAdapter,
  CodexStreamParser,
  codexRateLimitSamples,
  findRolloutFile,
} from "../../src/adapters/codex.js";
import { parseStructuredText, VendorFindingsOutputSchema } from "../../src/adapters/output.js";
import type { CliRequest } from "../../src/adapters/types.js";
import { fixture, lines } from "./helpers.js";
import { tempDir } from "../tmp.js";

function parse(name: string) {
  const parser = new CodexStreamParser();
  for (const line of lines(fixture(name))) parser.push(line);
  return parser.summary();
}

const base: CliRequest<unknown> = {
  prompt: "p",
  cwd: "/w",
  tools: "read-only",
  timeoutMs: 1,
  outputSchema: z.object({}),
};

describe("CodexStreamParser", () => {
  it("reads the thread, tokens, and last agent message", () => {
    const s = parse("codex-review.jsonl");
    expect(s.threadId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    expect(s.tokens).toEqual({ input: 24763, output: 122 });
    expect(s.errors).toEqual([]);
    expect(s.turnsCompleted).toBe(1);
    const output = parseStructuredText("codex", VendorFindingsOutputSchema, s.lastMessage!, "");
    expect(output.findings[0]).toMatchObject({
      severity: "P1",
      lines: [120, 134],
      verdict: "pending",
    });
  });

  it("collects turn.failed messages", () => {
    const s = parse("codex-usage-limit.jsonl");
    expect(s.errors).toEqual(["You’ve hit your usage limit. Try again at 3:15 PM."]);
    expect(s.lastMessage).toBeNull();
  });
});

describe("codexRateLimitSamples", () => {
  it("reads the newest token_count rate limits", () => {
    const samples = codexRateLimitSamples(
      fixture("codex-rollout.jsonl"),
      "user@example.com",
      DEFAULT_CEILINGS.codex,
    );
    expect(samples).toEqual([
      expect.objectContaining({
        window: "5h",
        utilization: 0.145,
        resetAt: "2026-10-28T07:00:00.000Z",
        sampleSource: "codex_session",
      }),
      expect.objectContaining({ window: "7d", utilization: 0.41 }),
    ]);
    for (const s of samples) UsageSampleSchema.parse(s);
  });

  it("returns nothing without rate limits", () => {
    expect(
      codexRateLimitSamples(
        '{"payload":{"type":"token_count","rate_limits":null}}',
        "a",
        DEFAULT_CEILINGS.codex,
      ),
    ).toEqual([]);
  });
});

describe("findRolloutFile", () => {
  it("finds the thread's rollout in the newest day directories", () => {
    const sessions = tempDir("agentbox-codex-sessions-");
    const day = join(sessions, "2026", "10", "28");
    mkdirSync(day, { recursive: true });
    mkdirSync(join(sessions, "2026", "10", "27"), { recursive: true });
    writeFileSync(join(day, "rollout-2026-10-28T09-00-00-abc.jsonl"), "");
    expect(findRolloutFile(sessions, "abc")).toBe(
      join(day, "rollout-2026-10-28T09-00-00-abc.jsonl"),
    );
    expect(findRolloutFile(sessions, "zzz")).toBeNull();
    expect(findRolloutFile(join(sessions, "missing"), "abc")).toBeNull();
  });
});

describe("CodexAdapter.buildArgs", () => {
  const adapter = new CodexAdapter();

  it("builds a read-only exec with the prompt on stdin", () => {
    const args = adapter.buildArgs({ ...base, model: "gpt-5.3-codex", effort: "high" }, "/s.json");
    expect(args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--json",
      "--skip-git-repo-check",
      "--output-schema",
      "/s.json",
      "--model",
      "gpt-5.3-codex",
      "-c",
      'model_reasoning_effort="high"',
      "-",
    ]);
  });

  it("runs a read-only call with a scratch directory in it, under workspace-write", () => {
    const request = { ...base, scratchDir: "/runs/r1/scratch/F-1" };
    const args = adapter.buildArgs(request, "/s.json");
    expect(args.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"]);
    expect(args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(adapter.workingDir(request)).toBe("/runs/r1/scratch/F-1");
    expect(adapter.workingDir(base)).toBe("/w");
    expect(adapter.workingDir({ ...base, tools: "write", scratchDir: "/x" })).toBe("/w");
  });

  it("puts --sandbox before resume", () => {
    const args = adapter.buildArgs({ ...base, sessionId: "t1" }, "/s.json");
    expect(args.slice(0, 5)).toEqual(["exec", "--sandbox", "read-only", "resume", "t1"]);
    expect(args.at(-1)).toBe("-");
  });

  it("uses workspace-write for writes, or bypass when configured", () => {
    expect(adapter.buildArgs({ ...base, tools: "write" }, "/s")).toContain("workspace-write");
    const bypass = new CodexAdapter({ writeMode: "bypass" }).buildArgs(
      { ...base, tools: "write" },
      "/s",
    );
    expect(bypass).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(bypass).not.toContain("--sandbox");
    expect(bypass).not.toContain("--full-auto");
  });
});
