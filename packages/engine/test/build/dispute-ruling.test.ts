// The test dispute ruling path from end to end (spec #95, issue #97), the
// path that stalled the T2 measurement: a Developer disputes a locked test
// twice, the second dispute goes to the Project manager, and the Project
// manager resolves it with the Architect's ruling for the Developer. The
// ruling must reach the Test engineer, who changes the locked test, and the
// build must then run on to release ready with no other escalation.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import { CART_DONE, REPORT, buildWorld, cartPlan, type MockResponse } from "./harness.js";

const SLUG = "cart-total";
const TEST_FILE = "test/cart.test.mjs";

/** A wrong test for AC1: it wants double the sum, so no right code passes it. */
const WRONG_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([{ price: 2 }, { price: 3 }]), 10);",
  "",
].join("\n");

/** The right test for AC1, which fails on an assertion against the stub. */
const RIGHT_TEST = WRONG_TEST.replace("]), 10);", "]), 5);");

const DISPUTE_REASON = "AC1 asks for the sum of the prices, 5, but the test wants 10.";

/** The Architect's ruling, which the Project manager sends with its `clarify` resolution. */
const RULING =
  "Architect's ruling: the Developer is right. AC1 is the plain sum of the item prices, so the test must expect 5, not 10.";

/** The Test engineer's tests first round, which locks the wrong test. */
const TESTS_FIRST: MockResponse = {
  match: "round 1 of",
  output: {
    summary: "Wrote the tests first.",
    tests: [
      {
        file: TEST_FILE,
        name: "AC1: the cart reports the sum of its item prices",
        criterion: "AC1",
        command: `node ${TEST_FILE}`,
      },
    ],
  },
  writeFiles: { [TEST_FILE]: WRONG_TEST },
};

/**
 * The Test engineer applies the ruling. It matches only a prompt that
 * carries the ruling, so a ruling that never reaches the Test engineer
 * leaves the test as it is locked.
 */
const APPLIES_RULING: MockResponse = {
  match: "the test must expect 5, not 10",
  output: { verdict: "amend", reason: "Applied the Architect's ruling.", changesCriterion: false },
  writeFiles: { [TEST_FILE]: RIGHT_TEST },
};

/** The Test engineer's first answer to a dispute: it keeps the test. */
const KEEPS_TEST: MockResponse = {
  match: "test dispute",
  output: { verdict: "reject", reason: "The test is right.", changesCriterion: false },
};

/** The Scribe of the release ready step. */
const SCRIBE: MockResponse = {
  match: "Task release",
  output: {
    summary: "Recorded the cart total.",
    pullRequest: { title: "feat(cart): add the cart total", body: "Adds `total()` to the cart." },
    records: [{ path: "CHANGELOG.md", kind: "changelog" }],
  },
  writeFiles: { "CHANGELOG.md": "# Changelog\n\n- Add the cart total.\n" },
};

/** Review answers that find nothing. */
const CLEAN_REVIEW: MockResponse = { output: { findings: [] } };

/** A Developer answer that writes the right code and disputes the locked test. */
function disputing(match: string): MockResponse {
  return {
    match,
    output: { ...REPORT, dispute: { test: TEST_FILE, reason: DISPUTE_REASON } },
    writeFiles: { "src/cart.mjs": CART_DONE },
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("a test dispute that the Architect rules on for the Developer", () => {
  it("reaches the Test engineer, changes the locked test, and the build runs to release ready", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE, review: true, release: true });
    world.script({
      codex: [TESTS_FIRST, APPLIES_RULING, KEEPS_TEST, SCRIBE, CLEAN_REVIEW],
      claude: [
        {
          match: "The fixed test is locked",
          output: REPORT,
          writeFiles: { "src/cart.mjs": CART_DONE },
        },
        disputing("is rejected"),
        disputing("attempt 1 of"),
        CLEAN_REVIEW,
      ],
    });

    await world.start(SLUG, cartPlan({ push: false }));
    const waiting = await world.settle(SLUG);

    // The second dispute about the test goes to the Project manager.
    expect(waiting).toMatchObject({ step: "tasks", status: "waiting_escalation" });
    expect(waiting.escalations).toEqual([
      expect.objectContaining({ id: "E1", kind: "test_dispute", level: "project_manager" }),
    ]);

    await world.manager.resolve(SLUG, { escalation: "E1", action: "clarify", note: RULING });
    const state = await world.settle(SLUG);

    // The build reaches release ready.
    expect(state).toMatchObject({ step: "release_ready", status: "finished" });
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });

    // The ruling is on file: the escalation's resolution and the dispute.
    const escalation = JSON.parse(world.file(SLUG, "escalations/E1.json")) as {
      status: string;
      resolution?: { action: string; note?: string };
    };
    expect(escalation).toMatchObject({
      status: "resolved",
      resolution: { action: "clarify", note: RULING },
    });
    expect(JSON.parse(world.file(SLUG, "tasks/T1/dispute-2.json"))).toMatchObject({
      outcome: "amended",
      escalation: "E1",
      ruling: RULING,
      check: { passed: true },
    });

    // The Test engineer's call after the resolution carries the ruling.
    const calls = world.calls();
    const resolved = calls.findIndex((c) => c.prompt.includes(RULING));
    expect(resolved).toBeGreaterThan(-1);
    expect(calls[resolved]).toMatchObject({ cli: "codex" });
    expect(calls[resolved]!.prompt).toMatch(/test dispute 2 of task T1/i);

    // The changed test is locked and committed on the build branch.
    const lock = JSON.parse(world.file(SLUG, "test-lock.json")) as {
      commit: string;
      files: { path: string; sha256: string }[];
      amendments?: { dispute: string; commit: string }[];
    };
    expect(lock.files).toEqual([{ path: TEST_FILE, sha256: sha256(RIGHT_TEST) }]);
    expect(lock.amendments).toEqual([
      expect.objectContaining({ dispute: "tasks/T1/dispute-2.json", commit: lock.commit }),
    ]);
    expect(world.git(world.root, "show", `${lock.commit}:${TEST_FILE}`)).toBe(RIGHT_TEST.trim());
    expect(world.git(world.root, "show", `build/${SLUG}:${TEST_FILE}`)).toBe(RIGHT_TEST.trim());
    expect(world.git(world.root, "show", `build/${SLUG}:src/cart.mjs`)).toBe(CART_DONE.trim());

    // No escalation is raised beyond the one that asks for the ruling.
    expect(state.escalations).toEqual([
      expect.objectContaining({ id: "E1", kind: "test_dispute", status: "resolved" }),
    ]);
    expect(world.jsonFiles(SLUG, "escalations")).toHaveLength(1);
  });
});
