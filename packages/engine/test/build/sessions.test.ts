// Session resume through the engine build API: the engine keeps each
// agent's session with its seat and tasks, and a message for an agent whose
// turn ended resumes that session, one turn at a time, with the commits
// that landed since.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionRegistrySchema, type SessionRecord } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import {
  CART_DONE,
  REPORT,
  buildWorld,
  cartPlan,
  type BuildWorld,
  type MockResponse,
} from "./harness.js";

const TEST_FILE = "test/cart.test.mjs";

/** A test for AC1 that fails on an assertion against the cart stub. */
const RED_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
  "",
].join("\n");

/** The Test engineer's tests first, which the engine commits and locks. */
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
  writeFiles: { [TEST_FILE]: RED_TEST },
};

const QUESTION = "Does AC1 cover an empty cart?";
const ANSWER = "Yes: an empty cart totals zero.";

/** A `send_message` call from a mock agent. */
function send(to: string, body: string, type = "question") {
  return { tool: "send_message", arguments: { type, to, toTask: "T1", body } };
}

/** The Developer's turn, which also asks the Test engineer `questions`. */
function developer(...questions: string[]): MockResponse {
  return {
    match: "Task T1",
    output: REPORT,
    writeFiles: { "src/cart.mjs": CART_DONE },
    busCalls: questions.map((q) => send("test-engineer", q)),
  };
}

const done = (match: string, extra: Partial<MockResponse> = {}): MockResponse => ({
  match,
  output: { summary: "Read the message." },
  ...extra,
});

function registry(world: BuildWorld, slug: string) {
  return SessionRegistrySchema.parse(JSON.parse(world.file(slug, "sessions.json")));
}

function sessionOf(sessions: SessionRecord[], seat: string): SessionRecord {
  const found = sessions.filter((s) => s.seat === seat && s.replacedBy === null);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** Writes the project's policy file with `sessions` settings. */
function policy(world: BuildWorld, sessions: string): void {
  mkdirSync(join(world.root, ".aio"), { recursive: true });
  writeFileSync(join(world.root, ".aio", "policy.yaml"), `version: 1\nsessions:\n${sessions}`);
}

describe("session resume", () => {
  it("delivers a question and its reply to the sessions that asked and answered, on Codex and Claude", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        done(QUESTION, { busCalls: [send("developer", ANSWER, "answer")] }),
        TESTS_FIRST,
      ],
      claude: [done(ANSWER), developer(QUESTION)],
    });

    await world.start("cart-ask");
    await world.settle("cart-ask");

    const { sessions, queue, deliveries } = registry(world, "cart-ask");
    const tester = sessionOf(sessions, "test-engineer");
    const dev = sessionOf(sessions, "developer");
    expect(tester).toMatchObject({ vendor: "codex", taskIds: ["T1"], step: "tests_first" });
    expect(tester.turns.map((t) => t.messageId)).toEqual([null, "M1"]);
    expect(dev).toMatchObject({ vendor: "claude", taskIds: ["T1"], step: "tasks" });
    expect(dev.turns.map((t) => t.messageId)).toEqual([null, "M2"]);
    expect(queue).toEqual([]);
    expect(deliveries.map((d) => [d.messageId, d.session, d.status])).toEqual([
      ["M1", tester.id, "delivered"],
      ["M2", dev.id, "delivered"],
    ]);

    const calls = world.calls();
    const codex = calls.filter((c) => c.cli === "codex");
    expect(codex).toHaveLength(2);
    expect(codex[0]!.resumeId).toBeNull();
    expect(codex[1]!.resumeId).toBe(tester.sessionId);
    expect(codex[1]!.prompt).toContain(QUESTION);
    const claude = calls.filter((c) => c.cli === "claude");
    expect(claude).toHaveLength(2);
    expect(claude[0]!.argv).not.toContain("--resume");
    expect(claude[1]!.argv.join(" ")).toContain(`--resume ${dev.sessionId}`);
    expect(claude[1]!.prompt).toContain(ANSWER);
  });

  it("tells a resumed session which commits landed since its last turn", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({ codex: [done(QUESTION), TESTS_FIRST], claude: [developer(QUESTION)] });

    await world.start("cart-commits");
    await world.settle("cart-commits");

    const resumed = world.calls().filter((c) => c.cli === "codex")[1]!;
    // The engine committed and locked the tests after the Test engineer's turn.
    const subject = "test(build): add the tests first for Add a total to the cart";
    const line = world
      .git(world.root, "log", "--format=%h %s", "build/cart-commits")
      .split("\n")
      .find((l) => l.endsWith(subject));
    expect(line).toBeDefined();
    expect(resumed.prompt).toContain(line);
  });
});
