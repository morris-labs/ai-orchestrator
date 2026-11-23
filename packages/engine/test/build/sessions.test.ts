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

  it("resumes a Copilot session for a message", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE, copilot: true });
    world.script({ copilot: [done(QUESTION), TESTS_FIRST], claude: [developer(QUESTION)] });
    const plan = cartPlan({ placements: { "test-engineer": { vendor: "copilot" } } });

    await world.start("cart-copilot", plan);
    await world.settle("cart-copilot");

    const tester = sessionOf(registry(world, "cart-copilot").sessions, "test-engineer");
    expect(tester.vendor).toBe("copilot");
    expect(tester.turns.map((t) => t.messageId)).toEqual([null, "M1"]);
    const copilot = world.calls().filter((c) => c.cli === "copilot");
    expect(copilot).toHaveLength(2);
    expect(copilot[0]!.argv.join(" ")).not.toContain("--resume");
    expect(copilot[1]!.argv).toContain(`--resume=${tester.sessionId}`);
  });

  it("runs two messages for one session as two turns, in order", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        done("first question", { delayMs: 400 }),
        done("second question"),
        TESTS_FIRST,
      ],
      claude: [developer("The first question.", "The second question.")],
    });

    const build = await world.start("cart-two");
    await world.settle("cart-two");

    const resumed = world.calls().filter((c) => c.cli === "codex" && c.resumeId);
    expect(resumed.map((c) => /The (\w+) question/.exec(c.prompt)?.[1])).toEqual([
      "first",
      "second",
    ]);
    const tester = sessionOf(registry(world, "cart-two").sessions, "test-engineer");
    expect(tester.turns.map((t) => t.messageId)).toEqual([null, "M1", "M2"]);
    // The second turn starts only after the first ends.
    const turns = world.events.events
      .filter((e) => e.type === "agent.started" || e.type === "agent.finished")
      .filter((e) => e.buildId === build.id && e.seat === "test-engineer")
      .map((e) => e.type);
    expect(turns).toEqual([
      "agent.started",
      "agent.finished",
      "agent.started",
      "agent.finished",
      "agent.started",
      "agent.finished",
    ]);
  });

  it("starts a fresh agent for a large session whose cache expired, and records the change", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    // Every Codex session is cold at once, and every turn is over the threshold.
    policy(world, "  freshAboveTokens: 100\n  cacheWindowMinutes:\n    codex: 0\n");
    world.script({ codex: [done(QUESTION), TESTS_FIRST], claude: [developer(QUESTION)] });

    await world.start("cart-fresh");
    await world.settle("cart-fresh");

    const { sessions, deliveries } = registry(world, "cart-fresh");
    const testers = sessions.filter((s) => s.seat === "test-engineer");
    expect(testers).toHaveLength(2);
    const [old, fresh] = testers as [SessionRecord, SessionRecord];
    expect(old).toMatchObject({ reason: "step", replacedBy: fresh.id });
    expect(fresh).toMatchObject({ reason: "size", replaces: old.id, replacedBy: null });
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(fresh.taskIds).toEqual(old.taskIds);
    expect(fresh.turns.map((t) => t.messageId)).toEqual(["M1"]);
    expect(deliveries).toEqual([expect.objectContaining({ messageId: "M1", session: fresh.id })]);

    const codex = world.calls().filter((c) => c.cli === "codex");
    expect(codex).toHaveLength(2);
    expect(codex[1]!.resumeId).toBeNull();
    // The fresh agent gets the role prompt, the task's files, and the message.
    expect(codex[1]!.prompt).toContain("You are the Test engineer");
    expect(codex[1]!.prompt).toContain(`- ${TEST_FILE}`);
    expect(codex[1]!.prompt).toContain(QUESTION);
  });

  it("keeps resuming a large session while the vendor's cache lasts", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    policy(world, "  freshAboveTokens: 100\n");
    world.script({ codex: [done(QUESTION), TESTS_FIRST], claude: [developer(QUESTION)] });

    await world.start("cart-warm");
    await world.settle("cart-warm");

    const testers = registry(world, "cart-warm").sessions.filter((s) => s.seat === "test-engineer");
    expect(testers).toHaveLength(1);
    expect(world.calls().filter((c) => c.cli === "codex")[1]!.resumeId).toBe(testers[0]!.sessionId);
  });

  it("keeps the registry and the queue through an engine restart", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      // The first answer to the question outlasts the engine that started it.
      codex: [done(QUESTION, { times: 1, delayMs: 20_000 }), done(QUESTION), TESTS_FIRST],
      claude: [{ ...developer(QUESTION), times: 1 }, developer()],
    });

    await world.start("cart-restart");
    const asked = () => world.calls().filter((c) => c.cli === "codex" && c.resumeId);
    const end = Date.now() + 20_000;
    while (asked().length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    const before = registry(world, "cart-restart");
    expect(before.queue).toEqual([{ messageId: "M1", seat: "test-engineer", taskId: "T1" }]);
    const tester = sessionOf(before.sessions, "test-engineer");

    await world.restart();
    await world.settle("cart-restart");

    const after = registry(world, "cart-restart");
    expect(after.queue).toEqual([]);
    expect(sessionOf(after.sessions, "test-engineer")).toMatchObject({
      id: tester.id,
      sessionId: tester.sessionId,
    });
    expect(sessionOf(after.sessions, "test-engineer").turns.map((t) => t.messageId)).toEqual([
      null,
      "M1",
    ]);
    expect(asked().map((c) => c.resumeId)).toEqual([tester.sessionId, tester.sessionId]);
    expect(world.jsonFiles("cart-restart", "messages")).toHaveLength(1);
  });
});
