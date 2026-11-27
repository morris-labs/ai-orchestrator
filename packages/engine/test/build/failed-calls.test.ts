// The usage of a Codex call that fails or that the engine stops (#100). The
// Codex adapter reads what the call spent from its rollout file, the call
// settles its lease with those tokens, and the build writes a call record
// for it. The mock Codex CLI writes its rollouts in a temporary account
// folder, never in the real `~/.codex`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import { tempDir } from "../tmp.js";
import { REPORT, buildWorld, type BuildWorld, type MockResponse } from "./harness.js";

const DEVELOPER: MockResponse = { match: "Task T1", output: REPORT };
const CLOSING: MockResponse = {
  match: "closing record",
  output: { record: "The owner stopped the build during tests first." },
};

interface SettledLease {
  type: string;
  seat?: string;
  step?: string;
  tokens: { in: number; out: number };
}

/** The tokens of the build's settled leases, by seat and step, from its events file. */
function usageBySeatAndStep(world: BuildWorld, slug: string): Record<string, number[]> {
  const usage: Record<string, number[]> = {};
  for (const line of world.file(slug, "events.jsonl").split("\n")) {
    if (!line.includes('"lease.settled"')) continue;
    const event = JSON.parse(line) as SettledLease;
    const key = `${event.seat}/${event.step}`;
    const row = usage[key] ?? [0, 0];
    usage[key] = [row[0]! + event.tokens.in, row[1]! + event.tokens.out];
  }
  return usage;
}

/** True once the mock Codex CLI wrote a rollout file under `home`. */
function hasRollout(home: string): boolean {
  const walk = (dir: string): boolean =>
    existsSync(dir) &&
    readdirSync(dir, { withFileTypes: true }).some((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.startsWith("rollout-"),
    );
  return walk(join(home, "sessions"));
}

describe("a Codex call that fails or stops", () => {
  it("records the tokens a failed call's rollout reports, in its lease and a call record", async () => {
    const home = tempDir("aio-codex-home-");
    const world = await buildWorld({ steps: BUILD_PIPELINE, accountDirs: { codex: () => home } });
    world.script({
      codex: [{ match: "round 1 of", error: "crash", tokens: { input: 5000, output: 70 } }],
      claude: [DEVELOPER],
    });

    await world.start("cart-failed");
    const state = await world.settle("cart-failed");

    expect(state.status).toBe("waiting_escalation");
    const failed = world.jsonFiles("cart-failed", "calls/failed");
    // The call failed, and so did its one retry.
    expect(failed).toHaveLength(2);
    for (const record of failed) {
      expect(record).toMatchObject({
        vendor: "codex",
        seat: "test-engineer",
        step: "tests_first",
        outcome: "error",
        tokens: { in: 5000, out: 70 },
      });
    }
    expect(world.events.ofType("agent.finished")).toEqual([
      expect.objectContaining({ outcome: "error", tokens: expect.objectContaining({ in: 5000 }) }),
      expect.objectContaining({ outcome: "error", tokens: expect.objectContaining({ in: 5000 }) }),
    ]);
    expect(usageBySeatAndStep(world, "cart-failed")).toEqual({
      "test-engineer/tests_first": [10_000, 140],
    });
    // A failed call's record doesn't stand in for a finished one.
    expect(world.jsonFiles("cart-failed", "calls")).toEqual([]);
  });

  it("records the tokens of a call the engine stops", async () => {
    const home = tempDir("aio-codex-home-");
    const world = await buildWorld({ steps: BUILD_PIPELINE, accountDirs: { codex: () => home } });
    world.script({
      codex: [
        { match: "round 1 of", delayMs: 20_000, tokens: { input: 4000, output: 30 } },
        CLOSING,
      ],
      claude: [DEVELOPER],
    });

    await world.start("cart-stopped");
    const end = Date.now() + 20_000;
    while (!hasRollout(home) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    await world.manager.cancel("cart-stopped");
    await world.waitFor("cart-stopped", (s) => s.closingRecord !== undefined);

    expect(world.jsonFiles("cart-stopped", "calls/failed")).toEqual([
      expect.objectContaining({
        vendor: "codex",
        seat: "test-engineer",
        step: "tests_first",
        outcome: "cancelled",
        tokens: expect.objectContaining({ in: 4000, out: 30 }),
      }),
    ]);
    const usage = usageBySeatAndStep(world, "cart-stopped");
    expect(usage["test-engineer/tests_first"]).toEqual([4000, 30]);
    expect(readFileSync(join(world.dir("cart-stopped"), "events.jsonl"), "utf8")).toContain(
      '"outcome":"cancelled"',
    );
  });
});
