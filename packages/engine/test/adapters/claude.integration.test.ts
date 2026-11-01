// Runs the Claude adapter against the real `claude` CLI. It costs a few
// cents, so it runs only with AIO_REAL_CLAUDE=1. Each run saves the raw
// stream to a temporary directory. The stream holds your paths, session IDs
// and tool lists, so don't commit it. Replace it with a synthetic fixture
// under fixtures/ before you use it in a test.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { UsageSampleSchema } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { VendorFindingsOutputSchema } from "../../src/adapters/output.js";
import { tempDir } from "../tmp.js";

const enabled = process.env.AIO_REAL_CLAUDE === "1";
const recorded = join(tmpdir(), "aio-recorded");

/** Saves a raw stream to the temporary directory, with the home directory replaced. */
function save(name: string, raw: string): void {
  mkdirSync(recorded, { recursive: true });
  writeFileSync(join(recorded, name), raw.split(homedir()).join("/home/user"));
}

describe.skipIf(!enabled)("Claude adapter against the real CLI", () => {
  // No session persistence: the temporary working directories would
  // otherwise leave transcript folders in ~/.claude/projects.
  const adapter = new ClaudeAdapter({ persistSessions: false });
  const model = "claude-haiku-5-5";

  it("reports health with a version", async () => {
    const health = await adapter.health();
    expect(health.available).toBe(true);
    expect(health.version).toMatch(/\d+\.\d+\.\d+/);
  });

  it("returns schema-valid findings and records the rate_limit_event", async () => {
    const cwd = tempDir("aio-claude-");
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
    save("claude-review.jsonl", result.raw);

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
    const cwd = tempDir("aio-claude-fix-");
    const result = await adapter.fix({
      prompt:
        "Create a file named done.txt in the current directory containing the word fixed, then report done true.",
      cwd,
      tools: "write",
      model,
      effort: "low",
      maxTurns: 4,
      maxBudgetUsd: 0.5,
      timeoutMs: 120_000,
      outputSchema: z.object({ done: z.boolean() }),
    });
    save("claude-fix.jsonl", result.raw);
    expect(result.output.done).toBe(true);
    expect(readFileSync(join(cwd, "done.txt"), "utf8")).toContain("fixed");
  }, 150_000);

  it("lets a read-only call write in its scratch directory and nowhere else", async () => {
    const cwd = tempDir("aio-claude-ro-");
    const scratch = join(tempDir("aio-claude-scratch-"), "F-0001");
    mkdirSync(scratch);
    const result = await adapter.verify({
      prompt:
        `Use the Write tool to create ${join(scratch, "repro.sh")} containing 'exit 1'. ` +
        `Then try to use the Write tool to create ${join(cwd, "bad.txt")} containing 'x'. ` +
        "Report wrote true if the first write worked.",
      cwd,
      scratchDir: scratch,
      tools: "read-only",
      model,
      effort: "low",
      maxTurns: 6,
      maxBudgetUsd: 0.5,
      timeoutMs: 120_000,
      outputSchema: z.object({ wrote: z.boolean() }),
    });
    expect(readFileSync(join(scratch, "repro.sh"), "utf8")).toContain("exit 1");
    expect(existsSync(join(cwd, "bad.txt"))).toBe(false);
    expect(typeof result.output.wrote).toBe("boolean");
  }, 150_000);
});
