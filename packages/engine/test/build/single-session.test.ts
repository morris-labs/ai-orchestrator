// The single-session flow (spec #95, issue #109): a build whose plan chooses
// the single-session flow runs one Developer session against the approved
// criteria, one review run in single PR mode whose confirmed findings go back
// to that same session, and release ready. It skips the Contracts step, tests
// first, and the Scribe.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRegistrySchema } from "@aio/contracts";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import {
  CART_DONE,
  REPORT,
  buildWorld,
  cartPlan,
  type BuildWorld,
  type MockResponse,
} from "./harness.js";

const SLUG = "cart-total";

/** The cart total with the planted flaw fixed: it counts each item's quantity. */
const CART_FIXED =
  "export function total(items) {\n  return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0);\n}\n";

/** The planted flaw: `total()` ignores each item's quantity. */
const FLAW = {
  severity: "P2",
  title: "total() ignores item quantity",
  file: "src/cart.mjs",
  lines: [1, 3],
  failure_case: "A cart with one item of price 2 and quantity 3 totals 2 instead of 6.",
  category: "correctness",
  introduced: true,
};

/** Every answer of the build: the Developer, then the review run that finds and fixes the flaw. */
function answers(): MockResponse[] {
  return [
    {
      match: "Fix (these|the) confirmed findings",
      output: { fixed: ["F-0001"], notFixed: [], summary: "Counted the quantity." },
      writeFiles: { "src/cart.mjs": CART_FIXED },
      commit: "fix(cart): count item quantity (F-1)",
    },
    {
      match: "Task T1",
      output: REPORT,
      writeFiles: { "src/cart.mjs": CART_DONE },
      tokens: { input: 1000, output: 100 },
    },
    { match: "Another agent fixed", output: { incomplete: [], findings: [] } },
    {
      match: "[Dd]isprove",
      output: {
        verdicts: [
          {
            id: "F-0001",
            verdict: "confirmed",
            verification: "code-reading",
            evidence: "total() adds item.price and never reads item.quantity.",
          },
        ],
        verdict: "confirmed",
        verification: "code-reading",
        evidence: "total() adds item.price and never reads item.quantity.",
      },
    },
    { match: "quantity", output: { findings: [] } },
    { times: 1, output: { findings: [FLAW] } },
    { output: { findings: [] } },
  ];
}

async function singleSessionBuild(): Promise<BuildWorld> {
  // The world runs every step of the pipeline: the flow decides which run.
  const world = await buildWorld({ steps: BUILD_PIPELINE, review: true, release: true });
  world.script({ claude: answers(), codex: answers() });
  await world.start(SLUG, cartPlan({ flow: "single_session", push: false }));
  return world;
}

describe("the single-session flow", () => {
  it("goes from approval to release ready with one Developer session and one review run", async () => {
    const world = await singleSessionBuild();
    const state = await world.settle(SLUG);

    expect(state).toMatchObject({ status: "finished", step: "release_ready" });
    expect(state.escalations).toEqual([]);
    expect(state.tasks).toEqual([expect.objectContaining({ id: "T1", status: "done" })]);
    expect(world.git(world.root, "show", `build/${SLUG}:src/cart.mjs`)).toBe(CART_FIXED.trim());
    // One review run, which reviewed the whole build diff.
    expect(world.jsonFiles(SLUG, "review")).toHaveLength(1);
  });

  it("sends the review run's confirmed findings back to the same Developer session", async () => {
    const world = await singleSessionBuild();
    await world.settle(SLUG);

    const { sessions } = SessionRegistrySchema.parse(JSON.parse(world.file(SLUG, "sessions.json")));
    expect(sessions).toEqual([
      expect.objectContaining({ seat: "developer", step: "tasks", replacedBy: null }),
    ]);
    const session = sessions[0]!.sessionId;
    expect(session).toBeTruthy();
    const developer = world.calls().filter((c) => c.prompt.includes("Task T1"));
    const fixes = developer.filter((c) => /Fix (these|the) confirmed findings/.test(c.prompt));
    const first = developer.find((c) => !fixes.includes(c));
    expect(first?.argv).not.toContain("--resume");
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.cli).toBe("claude");
    expect(fixes[0]?.argv.join(" ")).toContain(`--resume ${session}`);
    expect(fixes[0]?.prompt).toContain(FLAW.title);
  });

  it("keeps one Developer session across the plan's tasks", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      claude: [
        { match: "Task T2", output: REPORT, writeFiles: { "README.md": "# Shop\n\nTotals.\n" } },
        { match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
      ],
    });
    const plan = cartPlan({ size: "medium", flow: "single_session", push: false });
    plan.tasks.push({
      id: "T2",
      title: "Document the total",
      description: "Say in the README that the cart totals its items.",
      ownedFiles: ["README.md"],
      criteria: ["AC1"],
      dependsOn: ["T1"],
    });
    await world.start(SLUG, plan);
    const state = await world.waitFor(SLUG, (s) => s.step === "review");

    expect(state.tasks.map((t) => t.status)).toEqual(["done", "done"]);
    const { sessions } = SessionRegistrySchema.parse(JSON.parse(world.file(SLUG, "sessions.json")));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ seat: "developer", taskIds: ["T1", "T2"] });
    expect(sessions[0]!.turns.map((t) => t.key)).toEqual(["T1-attempt-1", "T2-attempt-1"]);
    const calls = world.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.argv).not.toContain("--resume");
    expect(calls[1]!.argv.join(" ")).toContain(`--resume ${sessions[0]!.sessionId}`);
    expect(calls[1]!.prompt).toContain("single-session flow");
  });

  it("writes a release-ready record with the criteria and the usage by seat and step", async () => {
    const world = await singleSessionBuild();
    await world.settle(SLUG);

    const digest = world.file(SLUG, "digests/release-ready.md");
    expect(digest).toContain("single-session flow");
    expect(digest).toContain("- AC1 (test): The cart reports the sum of its item prices.");
    expect(digest).toContain("## Usage by seat and step");
    expect(digest).toMatch(/\| developer \| tasks \| 1 \| 1000 \| 100 \|/);
    expect(digest).toMatch(/\| developer \| review \| 1 \|/);
    const pullRequest = world.file(SLUG, "release/pull-request.md");
    expect(pullRequest).toContain("AC1: The cart reports the sum of its item prices.");
  });

  it("makes no Contracts, tests-first, or Scribe call", async () => {
    const world = await singleSessionBuild();
    const state = await world.settle(SLUG);

    const settled = world.events
      .ofType("lease.settled")
      .filter((e) => e.buildId === state.id && e.runId === null);
    expect(settled.map((e) => `${e.seat}/${e.step}`)).toEqual(["developer/tasks"]);
    const steps = world.events
      .ofType("build.changed")
      .filter((e) => e.build.id === state.id)
      .map((e) => e.build.step);
    expect(new Set(steps)).toEqual(new Set(["preflight", "tasks", "review", "release_ready"]));
    const dir = world.dir(SLUG);
    expect(existsSync(join(dir, "release", "scribe.json"))).toBe(false);
    expect(existsSync(join(dir, "contracts"))).toBe(false);
    expect(existsSync(join(dir, "tests-first"))).toBe(false);
    expect(existsSync(join(dir, "test-lock.json"))).toBe(false);
  });
});
