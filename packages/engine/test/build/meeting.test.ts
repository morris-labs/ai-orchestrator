// The Critic meeting through the engine build API: the Project manager opens
// a meeting on the Architect's design, code takes the turns, and the mock
// vendor CLIs answer for the Architect (Claude) and the Critic (Codex).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BuildMeetingSchema,
  BuildPlanningSchema,
  type BuildMeeting,
  type BuildMeetingRequestInput,
} from "@aio/contracts";
import { PROJECT_ID, buildWorld, type BuildWorld, type MockResponse } from "./harness.js";

const SLUG = "cart-total";

const SPEC = {
  title: "Add a total to the cart",
  summary: "Shoppers see what their cart costs.",
  stories: ["As a shopper, I want the cart's total, so that I know what I pay."],
  edgeCases: ["An empty cart totals zero."],
  criteria: [
    { id: "AC1", text: "The cart reports the sum of its item prices.", verification: "test" },
  ],
  size: "medium",
  usageEstimate: { low: 100_000, high: 400_000 },
  secrets: [],
  services: [],
  recommendation: {
    flow: "single_session",
    highRisk: false,
    reason: "The change stays in the cart module and touches no stored data.",
  },
};

const DESIGN = {
  architecture: "The cart module's `total()` sums the item prices.",
  sharedFiles: [],
  milestones: [{ id: "M1", title: "Cart total", goal: "The cart totals.", tasks: ["T1"] }],
  tasks: [
    {
      id: "T1",
      title: "Cart total",
      description: "Make total() return the sum of the item prices.",
      ownedFiles: ["src/cart.mjs"],
      criteria: ["AC1"],
      tests: ["test/cart.test.mjs"],
      specialties: [],
    },
  ],
};

/** The revised design: the architecture now names the empty cart. */
const REVISED = {
  ...DESIGN,
  architecture: "The cart module's `total()` sums the item prices; an empty cart totals 0.",
};

const EMPTY_CART = "No task covers an empty cart.";

/** A Critic reply with a major objection. */
const OBJECTION = {
  position: "object",
  summary: "The design misses the empty cart.",
  points: [{ severity: "major", point: EMPTY_CART, reason: "The spec lists it as an edge case." }],
};

/** A Critic reply with only a minor point. */
const MINOR = {
  position: "concern",
  summary: "The design holds.",
  points: [{ severity: "minor", point: "Name the rounding rule.", reason: "Prices are floats." }],
};

const AGREED = { position: "no_objection", summary: "The design holds.", points: [] };

const CRITIC = "You are the Critic";
const ARCHITECT = "You are the Architect";

function request(extra: Partial<BuildMeetingRequestInput> = {}): BuildMeetingRequestInput {
  return {
    projectId: PROJECT_ID,
    boxId: "box-1",
    slug: SLUG,
    brief: "Attack the Architect's design for the cart total.",
    ...extra,
  };
}

/** A world in planning: the Analyst and the Architect answered, and the Critic answers `critic`. */
async function meetingWorld(critic: MockResponse[]): Promise<BuildWorld> {
  const world = await buildWorld();
  mkdirSync(join(world.root, ".aio"), { recursive: true });
  writeFileSync(
    join(world.root, ".aio/policy.yaml"),
    "version: 1\ntests:\n  - command: node test/cart.test.mjs\n",
  );
  world.script({
    claude: [
      { match: "You are the Analyst", output: SPEC },
      { match: ARCHITECT, times: 1, output: DESIGN },
      { match: ARCHITECT, output: REVISED },
    ],
    codex: critic,
  });
  const brief = "Add a total to the cart.";
  const seat = (name: string) => ({
    projectId: PROJECT_ID,
    boxId: "box-1",
    slug: SLUG,
    seat: name,
    brief,
  });
  await world.manager.plan(seat("analyst"));
  await world.manager.plan(seat("architect"));
  return world;
}

function prompts(world: BuildWorld, marker: string): string[] {
  return world
    .calls()
    .filter((c) => c.prompt.includes(marker))
    .map((c) => c.prompt);
}

function meetingFile(world: BuildWorld, id = "meeting-1"): BuildMeeting {
  return BuildMeetingSchema.parse(JSON.parse(world.file(SLUG, `meetings/${id}.json`)));
}

describe("the Critic meeting", () => {
  it("runs another round after a major objection and ends when none remains", async () => {
    const world = await meetingWorld([
      { match: CRITIC, times: 1, output: OBJECTION },
      { match: CRITIC, output: AGREED },
    ]);

    const { meeting, planning } = await world.manager.meet(request());

    expect(meeting).toMatchObject({ id: "meeting-1", status: "agreed", open: [] });
    expect(meeting.rounds).toHaveLength(2);
    expect(meeting.rounds.map((r) => r.proposal)).toEqual([
      "planning/architect-1.json",
      "planning/architect-2.json",
    ]);
    // The Architect revised once, from the Critic's objection.
    const architect = prompts(world, ARCHITECT);
    expect(architect).toHaveLength(2);
    expect(architect[1]).toContain(EMPTY_CART);
    // The Critic saw the revised design in round 2.
    expect(prompts(world, CRITIC)[1]).toContain("an empty cart totals 0");
    expect(planning.meetings).toEqual([
      { id: "meeting-1", file: "meetings/meeting-1.json", status: "agreed" },
    ]);
    // The revision is the design the draft plan comes from.
    expect(JSON.parse(world.file(SLUG, "planning/draft.json")).architecture).toBe(
      REVISED.architecture,
    );
    expect(meetingFile(world)).toEqual(meeting);
  });

  it("ends after one round when the replies hold no major objection", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: MINOR }]);

    const { meeting } = await world.manager.meet(request());

    expect(meeting.status).toBe("agreed");
    expect(meeting.rounds).toHaveLength(1);
    expect(meeting.rounds[0]?.turns[0]?.reply).toEqual(MINOR);
    expect(prompts(world, ARCHITECT)).toHaveLength(1);
  });

  it("stops at the round cap and reports the open objections", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: OBJECTION }]);

    const { meeting } = await world.manager.meet(request({ rounds: 2 }));

    expect(meeting.status).toBe("round_cap");
    expect(meeting.rounds).toHaveLength(2);
    expect(meeting.open).toEqual([{ seat: "critic", ...OBJECTION.points[0] }]);
    // No revision follows the last round: nobody would read it.
    expect(prompts(world, ARCHITECT)).toHaveLength(2);
    expect(world.file(SLUG, "STATUS.md")).toContain(EMPTY_CART);
  });

  it("stops at three rounds by default", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: OBJECTION }]);
    const { meeting } = await world.manager.meet(request());
    expect(meeting.status).toBe("round_cap");
    expect(meeting.rounds).toHaveLength(3);
  });

  it("sends a reply that breaks the structure back once", async () => {
    const world = await meetingWorld([
      { match: CRITIC, times: 1, output: { position: "maybe", summary: "Hm.", points: [] } },
      { match: CRITIC, output: AGREED },
    ]);

    const { meeting } = await world.manager.meet(request());

    expect(meeting.status).toBe("agreed");
    expect(meeting.rounds[0]?.turns[0]).toMatchObject({
      seat: "critic",
      status: "done",
      files: ["planning/critic-1.json", "planning/critic-2.json"],
      reply: AGREED,
    });
    const critic = prompts(world, CRITIC);
    expect(critic).toHaveLength(2);
    expect(critic[1]).toMatch(/broke the structure/);
    expect(critic[1]).toContain("position");
  });

  it("fails the meeting when the retry breaks the structure too", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: { position: "maybe" } }]);

    await expect(world.manager.meet(request())).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/critic.*structure/i),
    });
    expect(prompts(world, CRITIC)).toHaveLength(2);
    expect(meetingFile(world)).toMatchObject({ status: "failed" });
  });

  it("brings an owner post to every member at its next turn", async () => {
    const world = await meetingWorld([
      { match: CRITIC, times: 1, output: OBJECTION, delayMs: 1500 },
      { match: CRITIC, output: AGREED },
    ]);
    const post = "Keep the total in cents; the owner decided.";

    const meeting = world.manager.meet(request());
    // Post while the Critic's first turn runs.
    await waitFor(() => {
      if (!existsSync(join(world.dir(SLUG), "meetings/meeting-1.json"))) return false;
      return meetingFile(world).rounds[0]?.turns[0]?.status === "running";
    });
    const posted = await world.manager.meetingPost({
      projectId: PROJECT_ID,
      boxId: "box-1",
      slug: SLUG,
      meeting: "meeting-1",
      body: post,
    });
    expect(posted.meeting.posts).toEqual([{ body: post, postedAt: expect.any(String) }]);
    const { meeting: done } = await meeting;

    expect(prompts(world, CRITIC)[0]).not.toContain(post);
    expect(prompts(world, ARCHITECT)[1]).toContain(post);
    expect(prompts(world, CRITIC)[1]).toContain(post);
    expect(done.rounds[1]?.turns[0]?.posts).toEqual([0]);
  });

  it("routes an owner post for a seat in the meeting into the meeting", async () => {
    const world = await meetingWorld([
      { match: CRITIC, times: 1, output: OBJECTION, delayMs: 1500 },
      { match: CRITIC, output: AGREED },
    ]);
    const post = "Keep the total in cents; the owner decided.";

    const meeting = world.manager.meet(request());
    await waitFor(() => {
      if (!existsSync(join(world.dir(SLUG), "meetings/meeting-1.json"))) return false;
      return meetingFile(world).rounds[0]?.turns[0]?.status === "running";
    });
    const answer = await world.manager.post(SLUG, { to: "critic", body: post });
    expect(answer).toMatchObject({
      route: "meeting",
      meeting: { id: "meeting-1", posts: [{ body: post }] },
    });
    const { meeting: done } = await meeting;

    expect(prompts(world, CRITIC)[1]).toContain(post);
    expect(done.posts.map((p) => p.body)).toEqual([post]);
  });

  it("refuses an owner post in planning for a seat that holds no meeting", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: AGREED }]);
    await expect(
      world.manager.post(SLUG, { to: "critic", body: "Keep cents." }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("runs the Critic on a vendor other than the Architect's", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: AGREED }]);
    await world.manager.meet(request());
    expect(
      world
        .calls()
        .filter((c) => c.prompt.includes(CRITIC))
        .map((c) => c.cli),
    ).toEqual(["codex"]);
    const started = world.events
      .ofType("agent.started")
      .filter((e) => e.seat === "critic")
      .map((e) => e.placement?.vendor);
    expect(started).toEqual(["codex"]);
  });

  it("refuses a meeting whose Critic would share the Architect's vendor", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: AGREED }]);
    // A repository Critic placed on Claude, the Architect's vendor.
    const library = new URL("../../src/build/roles/library/critic.md", import.meta.url);
    mkdirSync(join(world.root, ".aio/team"), { recursive: true });
    writeFileSync(
      join(world.root, ".aio/team/critic.md"),
      readFileSync(library, "utf8").replace("vendor: codex", "vendor: claude"),
    );
    await world.restart();
    await expect(world.manager.meet(request())).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/critic.*other than claude/),
    });
    expect(prompts(world, CRITIC)).toEqual([]);
  });

  it("records each turn as a team chat message", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: MINOR }]);
    await world.manager.meet(request());
    const messages = world.jsonFiles(SLUG, "messages") as {
      type: string;
      from: { seat?: string };
      to: { seat?: string };
      taskId: string;
    }[];
    expect(messages.map((m) => [m.type, m.from.seat, m.to.seat, m.taskId])).toEqual([
      ["note", "architect", "critic", "meeting-1"],
      ["meeting_reply", "critic", "architect", "meeting-1"],
    ]);
  });

  it("refuses a post to a meeting that ended", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: AGREED }]);
    await world.manager.meet(request());
    await expect(
      world.manager.meetingPost({
        projectId: PROJECT_ID,
        boxId: null,
        slug: SLUG,
        meeting: "meeting-1",
        body: "Too late.",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      world.manager.meetingPost({
        projectId: PROJECT_ID,
        boxId: null,
        slug: SLUG,
        meeting: "meeting-9",
        body: "Nobody.",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("marks a meeting that an engine stop interrupted as failed", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: AGREED, delayMs: 3000 }]);
    const pending = world.manager.meet(request()).catch((error: unknown) => error);
    // The engine saves the meeting's record, then the planning record's entry
    // for it. Stop only after both, or the next engine finds no entry.
    await waitFor(() => {
      const file = join(world.dir(SLUG), "planning.json");
      return (
        existsSync(join(world.dir(SLUG), "meetings/meeting-1.json")) &&
        existsSync(file) &&
        readFileSync(file, "utf8").includes('"meeting-1"')
      );
    });
    await world.restart();
    // The next engine loads the planning record on its first request. (In a
    // test, the stopped engine's call still runs; a real engine exits.)
    await expect(
      world.manager.meetingPost({
        projectId: PROJECT_ID,
        boxId: null,
        slug: SLUG,
        meeting: "meeting-1",
        body: "Still there?",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const record = BuildPlanningSchema.parse(JSON.parse(world.file(SLUG, "planning.json")));
    expect(record.meetings).toEqual([
      { id: "meeting-1", file: "meetings/meeting-1.json", status: "failed" },
    ]);
    expect(meetingFile(world)).toMatchObject({ status: "failed" });
    await pending;
  });

  it("keeps a stopped engine's meeting from changing the records after the stop", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: AGREED, delayMs: 1500 }]);
    const pending = world.manager.meet(request()).catch((error: unknown) => error);
    // Stop while the Critic's CLI call is under way, so the stopped engine's
    // meeting gets an answer after the next engine marked it failed.
    await waitFor(() => prompts(world, CRITIC).length > 0);
    await world.restart();
    await expect(
      world.manager.meetingPost({
        projectId: PROJECT_ID,
        boxId: null,
        slug: SLUG,
        meeting: "meeting-1",
        body: "Still there?",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await pending;
    const record = BuildPlanningSchema.parse(JSON.parse(world.file(SLUG, "planning.json")));
    expect(record.meetings).toEqual([
      { id: "meeting-1", file: "meetings/meeting-1.json", status: "failed" },
    ]);
    expect(meetingFile(world)).toMatchObject({ status: "failed" });
  });

  it("marks a meeting failed when the engine stopped before the planning record listed it", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: AGREED, delayMs: 3000 }]);
    const pending = world.manager.meet(request()).catch((error: unknown) => error);
    await waitFor(() => existsSync(join(world.dir(SLUG), "meetings/meeting-1.json")));
    // The crash window: the meeting's record is saved, its planning entry is not.
    const file = join(world.dir(SLUG), "planning.json");
    await waitFor(() => existsSync(file));
    const planning = JSON.parse(readFileSync(file, "utf8")) as { meetings: unknown[] };
    planning.meetings = [];
    writeFileSync(file, JSON.stringify(planning));
    await world.restart();
    await expect(
      world.manager.meetingPost({
        projectId: PROJECT_ID,
        boxId: null,
        slug: SLUG,
        meeting: "meeting-1",
        body: "Still there?",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const record = BuildPlanningSchema.parse(JSON.parse(world.file(SLUG, "planning.json")));
    expect(record.meetings).toEqual([
      { id: "meeting-1", file: "meetings/meeting-1.json", status: "failed" },
    ]);
    expect(meetingFile(world)).toMatchObject({ status: "failed" });
    await pending;
  });
});

describe("ending a meeting early", () => {
  const scope = { projectId: PROJECT_ID, boxId: "box-1", slug: SLUG };

  it("stops the turn under way, keeps the last round's open objections, and frees planning", async () => {
    const world = await meetingWorld([
      { match: CRITIC, times: 1, output: OBJECTION },
      { match: CRITIC, output: AGREED, delayMs: 30_000 },
    ]);

    const meeting = world.manager.meet(request());
    // End the meeting while the Critic's second turn runs.
    await waitFor(() => {
      if (!existsSync(join(world.dir(SLUG), "meetings/meeting-1.json"))) return false;
      return meetingFile(world).rounds[1]?.turns[0]?.status === "running";
    });
    const started = Date.now();
    const ended = await world.manager.meetingEnd({ ...scope, meeting: "meeting-1" });
    const { meeting: done } = await meeting;

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(ended.meeting).toMatchObject({
      status: "ended",
      open: [{ seat: "critic", severity: "major", point: EMPTY_CART }],
    });
    expect(done.status).toBe("ended");
    expect(done.rounds[1]?.turns[0]?.status).toBe("failed");
    expect(ended.planning.meetings).toEqual([
      { id: "meeting-1", file: "meetings/meeting-1.json", status: "ended" },
    ]);
    expect(meetingFile(world)).toMatchObject({ status: "ended" });
    // Planning takes requests again.
    await expect(
      world.manager.meetingPost({ ...scope, meeting: "meeting-1", body: "Too late." }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      world.manager.plan({ ...scope, seat: "architect", brief: "Revise." }),
    ).resolves.toMatchObject({ call: { status: "done" } });
  });

  it("refuses to end a meeting that ended or that the build doesn't have", async () => {
    const world = await meetingWorld([{ match: CRITIC, output: AGREED }]);
    await world.manager.meet(request());

    await expect(
      world.manager.meetingEnd({ ...scope, meeting: "meeting-1" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      world.manager.meetingEnd({ ...scope, meeting: "meeting-9" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

async function waitFor(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("The condition never held.");
}
