// Owner posts and direct messages through the engine build API: an owner
// post runs only the agent it addresses, the engine records it as a
// decision that later agents on the task get, a post that contradicts an
// acceptance criterion is flagged to the Project manager, and an agent's
// direct messages to the owner stop at the limit per milestone without
// pausing the build.
import {
  BuildDecisionSchema,
  MessageSchema,
  type BuildDecision,
  type Message,
  type OwnerPostInput,
} from "@aio/contracts";
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
const RED_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
  "",
].join("\n");

/** The Test engineer's tests first. */
const testsFirst = (extra: Partial<MockResponse> = {}): MockResponse => ({
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
  ...extra,
});

const developer = (extra: Partial<MockResponse> = {}): MockResponse => ({
  match: "Task T1",
  output: REPORT,
  writeFiles: { "src/cart.mjs": CART_DONE },
  ...extra,
});

const POST = "Keep the total in whole dollars; the shop has no cents.";

/** Posts as the owner to an agent of a started build, and returns the message and its decision. */
async function postToAgent(
  world: BuildWorld,
  slug: string,
  input: OwnerPostInput,
): Promise<{ message: Message; decision: BuildDecision }> {
  const answer = await world.manager.post(slug, input);
  if (answer.route !== "agent") throw new Error(`Expected the agent route, got ${answer.route}.`);
  return answer;
}

type LoggedCall = MockCall & { busResults?: { isError: boolean; text: string }[] };

describe("owner posts", () => {
  it("resumes only the agent the post addresses", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [testsFirst()],
      claude: [{ match: POST, output: { summary: "Kept dollars." } }, developer()],
    });
    await world.start("cart-post");
    await world.settle("cart-post");
    const before = world.calls();

    const { message, decision } = await postToAgent(world, "cart-post", {
      to: "developer",
      toTask: "T1",
      body: POST,
    });
    await world.waitFor("cart-post", () => world.calls().length > before.length);
    // Let any other turn the post might wrongly start show up.
    await new Promise((r) => setTimeout(r, 300));

    expect(message).toMatchObject({
      from: { kind: "owner" },
      to: { kind: "seat", seat: "developer", taskId: "T1" },
      taskId: "T1",
      body: POST,
    });
    expect(decision).toMatchObject({ id: "D1", messageId: message.id, taskId: "T1" });
    const added = world.calls().slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]!.cli).toBe("claude");
    expect(added[0]!.argv).toContain("--resume");
    expect(added[0]!.prompt).toContain(POST);
  });

  it("records the post as a decision that later agents on the task get", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      // The Test engineer's turn is slow, so the post lands before the Developer starts.
      codex: [testsFirst({ delayMs: 800 })],
      claude: [developer()],
    });
    await world.start("cart-decide");
    const { decision } = await postToAgent(world, "cart-decide", {
      to: "developer",
      toTask: "T1",
      body: POST,
    });
    await world.settle("cart-decide");

    expect(
      world.jsonFiles("cart-decide", "decisions").map((d) => BuildDecisionSchema.parse(d)),
    ).toEqual([decision]);
    const dev = world.calls().filter((c) => c.cli === "claude");
    expect(dev).toHaveLength(1);
    expect(dev[0]!.prompt).toContain("## Owner decisions");
    expect(dev[0]!.prompt).toContain(POST);
    // The post didn't start a turn of its own: no agent held the seat yet.
    expect(dev[0]!.argv).not.toContain("--resume");
    expect(await world.manager.decisions("cart-decide")).toEqual([decision]);
  });

  it("flags a post that contradicts an acceptance criterion to the Project manager", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        {
          match: POST,
          output: {
            summary: "The post conflicts with the plan.",
            contradicts: [{ criterion: "AC1", reason: "AC1 asks for the exact sum of prices." }],
          },
        },
        developer(),
      ],
    });
    await world.start("cart-flag");
    await world.settle("cart-flag");

    const { message } = await postToAgent(world, "cart-flag", {
      to: "developer",
      toTask: "T1",
      body: POST,
    });
    let flagged: Awaited<ReturnType<typeof world.manager.decisions>> = [];
    await world.waitFor("cart-flag", () => true);
    for (let i = 0; i < 200 && !flagged[0]?.planChange; i++) {
      await new Promise((r) => setTimeout(r, 25));
      flagged = await world.manager.decisions("cart-flag");
    }

    expect(flagged[0]?.planChange).toMatchObject({
      criteria: ["AC1"],
      reason: expect.stringContaining("exact sum"),
      reportedBy: { kind: "seat", seat: "developer", taskId: "T1" },
    });
    const prompt = world.calls().at(-1)!.prompt;
    expect(prompt).toContain("AC1: The cart reports the sum of its item prices.");
    const toPm = (await world.manager.messages("cart-flag")).filter(
      (m) => m.to.kind === "seat" && m.to.seat === "project-manager",
    );
    expect(toPm).toHaveLength(1);
    expect(toPm[0]!.body).toContain(message.id);
    expect(toPm[0]!.body).toContain("AC1");
    expect(flagged[0]!.planChange!.messageId).toBe(toPm[0]!.id);
  });

  it("refuses a post to a build that ended", async () => {
    const world = await buildWorld({ steps: ["preflight"] });
    await world.start("cart-ended");
    await world.settle("cart-ended");
    await expect(
      world.manager.post("cart-ended", { to: "developer", toTask: "T1", body: POST }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      world.manager.post("cart-none", { to: "developer", body: POST }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("direct messages", () => {
  const dm = (body: string) => ({
    tool: "send_message",
    arguments: { type: "note", to: "owner", body },
  });

  it("refuses a direct message past the limit with a reason, and the build goes on", async () => {
    const world = await buildWorld();
    world.script({
      claude: [developer({ busCalls: [dm("First."), dm("Second."), dm("Third.")] })],
    });
    await world.start("cart-dm");
    const state = await world.settle("cart-dm");

    // The build ran on to the review step, where a build world waits.
    expect(state.step).toBe("review");
    const results = (world.calls()[0] as LoggedCall).busResults ?? [];
    expect(results.map((r) => r.isError)).toEqual([false, false, true]);
    expect(results[2]!.text).toMatch(/2 direct messages/);
    expect(results[2]!.text).toMatch(/limit/);
    const sent = world.jsonFiles("cart-dm", "messages").map((m) => MessageSchema.parse(m));
    expect(sent.map((m) => m.body)).toEqual(["First.", "Second."]);
  });

  it("takes the limit from the plan", async () => {
    const world = await buildWorld();
    world.script({ claude: [developer({ busCalls: [dm("Only.")] })] });
    await world.start("cart-none-allowed", cartPlan({ directMessagesPerMilestone: 0 }));
    await world.settle("cart-none-allowed");
    const results = (world.calls()[0] as LoggedCall).busResults ?? [];
    expect(results.map((r) => r.isError)).toEqual([true]);
    expect(results[0]!.text).toMatch(/0 direct messages/);
  });

  it("lets the Project manager read every direct message", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        developer({
          busCalls: [
            dm("The criteria miss an empty cart."),
            { tool: "send_message", arguments: { type: "question", body: "Which currency?" } },
          ],
        }),
      ],
    });
    await world.start("cart-read");
    await world.settle("cart-read");

    const direct = await world.manager.messages("cart-read", { direct: true });
    expect(direct.map((m) => [m.from, m.to, m.body])).toEqual([
      [
        { kind: "seat", seat: "developer", taskId: "T1" },
        { kind: "owner" },
        "The criteria miss an empty cart.",
      ],
    ]);
    expect(await world.manager.messages("cart-read")).toHaveLength(2);
  });
});
