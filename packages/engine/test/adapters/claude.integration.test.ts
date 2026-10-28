// Runs the Claude adapter against the real `claude` CLI. It costs a few
// cents, so it runs only with AGENTBOX_REAL_CLAUDE=1. Each run saves the raw
// stream under fixtures/ for the fixture tests.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageSampleSchema } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { VendorFindingsOutputSchema } from "../../src/adapters/output.js";

const enabled = process.env.AGENTBOX_REAL_CLAUDE === "1";
const fixtures = join(import.meta.dirname, "fixtures");

describe.skipIf(!enabled)("Claude adapter against the real CLI", () => {
  const adapter = new ClaudeAdapter();
  const model = "claude-haiku-5-5";

  it("reports health with a version", async () => {
    const health = await adapter.health();
    expect(health.available).toBe(true);
    expect(health.version).toMatch(/\d+\.\d+\.\d+/);
  });

  it("returns schema-valid findings and records the rate_limit_event", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentbox-claude-"));
    writeFileSync(join(cwd, "a.ts"), "// teh greeting\nexport const greet = () => 'hi';\n");
    const seen: unknown[] = [];
    const result = await adapter.review({
      prompt:
        "Without using any tools, report exactly one finding: file a.ts, lines 1 to 1, " +
        "severity nit, title 'Typo in comment', category style, introduced true, " +
        "failure_case 'The comment misspells the'.",
      cwd,
      tools: "read-only",
      model,
      effort: "low",
      // Structured output takes a second turn: the model answers through a tool call.
      maxTurns: 2,
      maxBudgetUsd: 0.5,
      timeoutMs: 120_000,
      outputSchema: VendorFindingsOutputSchema,
      onUsage: (sample) => seen.push(sample),
    });
    writeFileSync(join(fixtures, "claude-real-review.jsonl"), result.raw);

    expect(result.output.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.output.findings[0]?.file).toBe("a.ts");
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.tokens.output).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.usage.length).toBeGreaterThanOrEqual(1);
    for (const sample of result.usage) UsageSampleSchema.parse(sample);
    expect(result.usage.map((s) => s.window)).toContain("5h");
    expect(seen).toHaveLength(result.usage.length);
  }, 150_000);

  it("writes a file with tools set to write", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentbox-claude-fix-"));
    const result = await adapter.fix({
      prompt: "Create a file named done.txt in the current directory containing the word fixed, then report done true.",
      cwd,
      tools: "write",
      model,
      effort: "low",
      maxTurns: 4,
      maxBudgetUsd: 0.5,
      timeoutMs: 120_000,
      outputSchema: z.object({ done: z.boolean() }),
    });
    writeFileSync(join(fixtures, "claude-real-fix.jsonl"), result.raw);
    expect(result.output.done).toBe(true);
    expect(readFileSync(join(cwd, "done.txt"), "utf8")).toContain("fixed");
  }, 150_000);
});
