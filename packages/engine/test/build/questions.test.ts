// Questions on the team chat: an answer that replies to a question goes back
// to the agent that asked it, in the same thread, and reaches that agent's
// resumed session. Each agent can ask a set number of questions per task;
// a question past the cap goes to the Project manager as an escalation.
import { MessageSchema, type Message } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import {
  CART_DONE,
  REPORT,
  buildWorld,
  cartPlan,
  type BuildWorld,
  type MockCall,
  type MockResponse,
} from "./harness.js";

const TEST_FILE = "test/cart.test.mjs";

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
  writeFiles: {
    [TEST_FILE]: [
      "// AC1: the cart reports the sum of its item prices.",
      'import assert from "node:assert/strict";',
      'import { total } from "../src/cart.mjs";',
      "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
      "",
    ].join("\n"),
  },
};

const QUESTION = "Does AC1 cover an empty cart?";
const ANSWER = "Yes: an empty cart totals zero.";

type LoggedCall = MockCall & { busResults?: { isError: boolean; text: string }[] };

/** A question from a mock agent; without `to`, the engine routes it to the Project manager. */
function question(body: string, to?: string) {
  return {
    tool: "send_message",
    arguments: { type: "question", body, ...(to ? { to, toTask: "T1" } : {}) },
  };
}

/** The Developer's attempt on T1, which asks `count` questions of the Project manager. */
function asking(count: number): MockResponse {
  return {
    match: "Task T1",
    output: REPORT,
    writeFiles: { "src/cart.mjs": CART_DONE },
    busCalls: Array.from({ length: count }, (_, i) => question(`Question ${i + 1} about T1?`)),
  };
}

function messages(world: BuildWorld, slug: string): Message[] {
  return world
    .jsonFiles(slug, "messages")
    .map((m) => MessageSchema.parse(m))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

describe("questions", () => {
  it("threads an answer with its question and delivers it to the asker's resumed session", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        // The Test engineer answers by replying to the question, without naming the asker.
        {
          match: QUESTION,
          output: { summary: "Answered." },
          busCalls: [
            { tool: "send_message", arguments: { type: "answer", replyTo: "M1", body: ANSWER } },
          ],
        },
        TESTS_FIRST,
      ],
      claude: [
        { match: ANSWER, output: { summary: "Read the answer." } },
        {
          match: "Task T1",
          output: REPORT,
          writeFiles: { "src/cart.mjs": CART_DONE },
          busCalls: [question(QUESTION, "test-engineer")],
        },
      ],
    });

    await world.start("cart-thread");
    await world.settle("cart-thread");

    const [asked, answered] = messages(world, "cart-thread");
    expect(asked).toMatchObject({ id: "M1", type: "question", taskId: "T1" });
    expect(asked!.replyTo).toBeUndefined();
    expect(answered).toMatchObject({
      id: "M2",
      type: "answer",
      from: { kind: "seat", seat: "test-engineer", taskId: "T1" },
      to: { kind: "seat", seat: "developer", taskId: "T1" },
      routing: "reply",
      replyTo: "M1",
      thread: "M1",
      taskId: "T1",
    });

    const developer = world.calls().filter((c) => c.cli === "claude");
    expect(developer).toHaveLength(2);
    expect(developer[1]!.argv).toContain("--resume");
    expect(developer[1]!.prompt).toContain(ANSWER);
    expect(developer[1]!.prompt).toContain("in reply to M1");
  });

  it("refuses a reply to a message the build doesn't have", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        {
          match: "Task T1",
          output: REPORT,
          writeFiles: { "src/cart.mjs": CART_DONE },
          busCalls: [
            { tool: "send_message", arguments: { type: "answer", replyTo: "M9", body: ANSWER } },
          ],
        },
      ],
    });
    await world.start("cart-orphan");
    await world.settle("cart-orphan");

    expect(messages(world, "cart-orphan")).toEqual([]);
    const [call] = world.calls() as LoggedCall[];
    expect(call!.busResults).toEqual([
      expect.objectContaining({ isError: true, text: expect.stringContaining("M9") }),
    ]);
  });

  it("sends the sixth question on a task to the Project manager as an escalation", async () => {
    const world = await buildWorld();
    world.script({ claude: [asking(6)] });
    await world.start("cart-curious");
    const state = await world.settle("cart-curious");

    expect(state.status).toBe("waiting_escalation");
    expect(state.escalations).toEqual([
      expect.objectContaining({
        id: "E1",
        kind: "question_cap",
        level: "project_manager",
        taskId: "T1",
        status: "open",
      }),
    ]);
    expect(state.tasks[0]).toMatchObject({ id: "T1", status: "failed" });
    const details = world.file("cart-curious", state.escalations[0]!.file);
    expect(details).toContain("M6");
    expect(details).toContain("Question 6 about T1?");
    // The Project manager gets one pointer to the escalation, whose file holds the question.
    const inbox = await world.manager.inbox("cart-curious");
    expect(inbox.items.map((i) => [i.kind, i.ref, i.file])).toEqual([
      ["escalation", "E1", state.escalations[0]!.file],
    ]);

    const saved = messages(world, "cart-curious");
    expect(saved).toHaveLength(6);
    expect(saved.slice(0, 5).every((m) => m.routing === "by_type")).toBe(true);
    expect(saved[5]).toMatchObject({
      id: "M6",
      to: { kind: "seat", seat: "project-manager", taskId: null },
      routing: "escalated",
    });
    const [call] = world.calls() as LoggedCall[];
    expect(call!.busResults).toHaveLength(6);
    expect(call!.busResults!.every((r) => !r.isError)).toBe(true);
    expect(call!.busResults![5]!.text).toContain("as an escalation");
  });

  it("takes the question cap from the build plan", async () => {
    const world = await buildWorld();
    world.script({ claude: [asking(3)] });
    await world.start("cart-capped", cartPlan({ questionsPerTask: 2 }));
    const state = await world.settle("cart-capped");

    expect(state.escalations.map((e) => e.kind)).toEqual(["question_cap"]);
    expect(messages(world, "cart-capped").map((m) => m.routing)).toEqual([
      "by_type",
      "by_type",
      "escalated",
    ]);
  });

  it("goes on with the task once the Project manager resolves the escalation", async () => {
    const world = await buildWorld();
    world.script({ claude: [asking(6)] });
    await world.start("cart-resumed");
    await world.settle("cart-resumed");

    await world.manager.resolve("cart-resumed", {
      escalation: "E1",
      action: "retry",
      note: "Answered the questions in the plan.",
    });
    const state = await world.waitFor("cart-resumed", (s) => s.tasks[0]?.status === "done");
    // The attempt that asked the questions passed its gate, so the task needs no new call.
    expect(state.tasks[0]).toMatchObject({ attempts: 1 });
    expect(world.calls()).toHaveLength(1);
  });
});
