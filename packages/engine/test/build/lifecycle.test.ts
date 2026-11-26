// The build lifecycle: one active build per box, a pause for a box stop and
// a resume for its start, cancel with a closing record, resume after a
// cancel, and delete. Driven through the engine build API and the mock
// vendor CLIs.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunCancelled } from "../../src/calls/errors.js";
import { BUILD_CLOSING_RECORD, type BuildState } from "@aio/contracts";
import {
  CART_DONE,
  PROJECT_ID,
  REPORT,
  buildWorld,
  cartPlan,
  type BuildWorld,
  type MockResponse,
} from "./harness.js";

/** A Developer turn that runs long enough to stop it part way. */
const SLOW_DEVELOPER: MockResponse = {
  match: "Task T1",
  delayMs: 20_000,
  output: REPORT,
  writeFiles: { "src/cart.mjs": CART_DONE },
};

const DEVELOPER: MockResponse = {
  match: "Task T1",
  output: REPORT,
  writeFiles: { "src/cart.mjs": CART_DONE },
};

/** The Scribe's closing record answer. */
const CLOSING: MockResponse = {
  match: "closing record",
  output: { record: "The cart total was under way when the owner stopped the build." },
};

function startIn(world: BuildWorld, slug: string, boxId: string): Promise<BuildState> {
  return world.manager.start({ projectId: PROJECT_ID, boxId, slug, plan: cartPlan() });
}

function agentStarted(world: BuildWorld): Promise<BuildState> {
  return world.waitFor("cart-total", () =>
    world.events.events.some((e) => e.type === "agent.started"),
  );
}

describe("one build per box", () => {
  it("refuses a second active build in a box with the reason, and frees the box on cancel", async () => {
    const world = await buildWorld();
    world.script({ claude: [SLOW_DEVELOPER] });
    await startIn(world, "cart-total", "box-a");

    await expect(startIn(world, "cart-tax", "box-a")).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("cart-total"),
    });
    // The refused build leaves no branch behind.
    expect(world.git(world.root, "branch", "--list", "build/cart-tax")).toBe("");
    // Another box runs its own build.
    await expect(startIn(world, "cart-tax", "box-b")).resolves.toMatchObject({ boxId: "box-b" });

    await world.manager.cancel("cart-total");
    await expect(startIn(world, "cart-fees", "box-a")).resolves.toMatchObject({ boxId: "box-a" });
    // The cancelled build can't resume while another build holds its box.
    await expect(world.manager.resume("cart-total")).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("cart-fees"),
    });
  });
});

describe("a box stop and start", () => {
  it("pauses the build after the running turn and resumes it on the box start", async () => {
    const world = await buildWorld();
    world.script({ claude: [{ ...SLOW_DEVELOPER, delayMs: 1500 }] });
    await startIn(world, "cart-total", "box-a");
    await agentStarted(world);

    const paused = await world.manager.pause("cart-total", "box");
    expect(paused).toMatchObject({ status: "paused", pausedBy: "box" });
    // The running turn finishes, and the build holds before the gate.
    await world.waitFor("cart-total", () => world.jsonFiles("cart-total", "calls").length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await world.manager.get("cart-total")).toMatchObject({ status: "paused" });

    const resumed = await world.manager.resume("cart-total", "box");
    expect(resumed.status).toBe("running");
    expect(resumed.pausedBy).toBeUndefined();
    const state = await world.waitFor("cart-total", (s) => s.step === "review");
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
  });

  it("leaves a build that the owner paused paused when the box starts", async () => {
    const world = await buildWorld();
    world.script({ claude: [{ ...SLOW_DEVELOPER, delayMs: 1500 }] });
    await startIn(world, "cart-total", "box-a");
    await agentStarted(world);

    expect(await world.manager.pause("cart-total")).toMatchObject({ pausedBy: "owner" });
    await expect(world.manager.resume("cart-total", "box")).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(await world.manager.get("cart-total")).toMatchObject({ status: "paused" });
    await expect(world.manager.resume("cart-total")).resolves.toMatchObject({ status: "running" });
  });
});

describe("a paused build", () => {
  it("reports idle once the running turn ends and the drive holds, and a resume clears it", async () => {
    const world = await buildWorld();
    world.script({ claude: [{ ...SLOW_DEVELOPER, delayMs: 1500 }] });
    await startIn(world, "cart-total", "box-a");
    await agentStarted(world);

    const paused = await world.manager.pause("cart-total");
    expect(paused.status).toBe("paused");
    expect(paused.idle).toBeUndefined();

    // The state file changes before the build.changed event goes out, so
    // wait for both.
    const idleSent = () =>
      (world.events.ofType("build.changed") as { build: { idle?: boolean } }[]).some(
        (e) => e.build.idle === true,
      );
    const idle = await world.waitFor("cart-total", (s) => s.idle === true && idleSent());
    expect(idle.status).toBe("paused");
    // The running turn finished before the build went idle.
    expect(world.jsonFiles("cart-total", "calls")).toHaveLength(1);
    const changes = world.events.ofType("build.changed") as { build: { idle?: boolean } }[];
    expect(changes.at(-1)?.build).toMatchObject({ status: "paused", idle: true });
    expect(world.file("cart-total", "STATUS.md")).toContain("- Status: paused (idle)");

    const resumed = await world.manager.resume("cart-total");
    expect(resumed.idle).toBeUndefined();
    const state = await world.waitFor("cart-total", (s) => s.step === "review");
    expect(state.idle).toBeUndefined();
  });

  it("reports idle at once when no drive runs, as while it waits for an escalation", async () => {
    const world = await buildWorld();
    world.script({ claude: [{ match: "Task T1", times: 2, error: "crash" }] });
    await startIn(world, "cart-total", "box-a");
    const waiting = await world.settle("cart-total");
    expect(waiting.status).toBe("waiting_escalation");

    const paused = await world.manager.pause("cart-total");
    expect(paused).toMatchObject({ status: "paused", idle: true });
  });
});

describe("a box stop during a usage limit wait", () => {
  it("holds the build paused for the box until the box starts", async () => {
    const world = await buildWorld();
    world.script({ claude: [{ match: "Task T1", error: "usage_limit", times: 1 }, DEVELOPER] });
    await startIn(world, "cart-total", "box-a");
    const waiting = await world.waitFor("cart-total", (s) => s.pausedUntil !== undefined);
    expect(waiting.status).toBe("paused");

    const paused = await world.manager.pause("cart-total", "box");
    expect(paused).toMatchObject({ status: "paused", pausedBy: "box" });
    expect(paused.pausedUntil).toBeUndefined();
    // An engine restart leaves a build that its box's stop paused alone.
    await world.restart();
    await new Promise((r) => setTimeout(r, 300));
    expect(await world.manager.get("cart-total")).toMatchObject({
      status: "paused",
      pausedBy: "box",
    });

    // The box start returns the build to its wait for the limit reset.
    await world.manager.resume("cart-total", "box");
    const state = await world.waitFor("cart-total", (s) => s.pausedUntil !== undefined);
    expect(state).toMatchObject({ status: "paused", pausedUntil: waiting.pausedUntil });
    expect(state.pausedBy).toBeUndefined();
  });
});

describe("cancel, resume, and delete", () => {
  it("stays cancelled when an escalation was resolved during the drive it stops", async () => {
    let drives = 0;
    const world = await buildWorld({
      handlers: {
        // A step that escalates about its task, then works until the drive stops.
        tasks: async (ctx) => {
          drives += 1;
          // A slow worktree check, so a drive that starts during the cancel
          // outlasts it instead of stopping on the cancel request.
          const ensure = ctx.worktree.ensure.bind(ctx.worktree);
          ctx.worktree.ensure = async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await ensure();
          };
          if (ctx.state.escalations.length === 0) {
            await ctx.escalate({
              kind: "agent_call",
              level: "project_manager",
              taskId: "T1",
              summary: "The Developer's call needs a person.",
              details: "",
            });
          }
          await new Promise((_resolve, reject) => {
            const stop = () => reject(new RunCancelled());
            if (ctx.signal.aborted) stop();
            ctx.signal.addEventListener("abort", stop);
          });
          return "wait";
        },
      },
    });
    world.script({ codex: [CLOSING] });
    await startIn(world, "cart-total", "box-a");
    await world.waitFor("cart-total", (s) => s.escalations.length === 1);
    // The resolution comes in while the drive that escalated still works.
    await world.manager.resolve("cart-total", { escalation: "E1", action: "retry" });

    await world.manager.cancel("cart-total");
    await world.waitFor("cart-total", (s) => s.closingRecord !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(drives).toBe(1);
    expect(await world.manager.get("cart-total")).toMatchObject({ status: "cancelled" });
  });

  it("stops the agent, keeps the branch and worktree, and has the Scribe write a closing record", async () => {
    const world = await buildWorld();
    world.script({ claude: [SLOW_DEVELOPER], codex: [CLOSING] });
    const started = await startIn(world, "cart-total", "box-a");
    await agentStarted(world);

    const began = Date.now();
    const cancelled = await world.manager.cancel("cart-total");
    expect(cancelled.status).toBe("cancelled");
    // The agent stops at once, not after its 20-second turn.
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(world.jsonFiles("cart-total", "calls")).toEqual([]);
    expect(existsSync(started.worktree)).toBe(true);
    expect(world.git(world.root, "branch", "--list", "build/cart-total")).toContain(
      "build/cart-total",
    );

    const closed = await world.waitFor("cart-total", (s) => s.closingRecord !== undefined);
    expect(closed).toMatchObject({ status: "cancelled", closingRecord: BUILD_CLOSING_RECORD });
    const record = world.file("cart-total", BUILD_CLOSING_RECORD);
    expect(record).toContain("The cart total was under way when the owner stopped the build.");
    expect(record).toMatch(/cancelled the build at the tasks step/i);
    expect(record).toContain("T1");
    await expect(world.manager.cancel("cart-total")).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("delivers the closing record to the Project manager's inbox", async () => {
    const world = await buildWorld();
    world.script({ claude: [SLOW_DEVELOPER], codex: [CLOSING] });
    await startIn(world, "cart-total", "box-a");
    await agentStarted(world);

    await world.manager.cancel("cart-total");
    await world.waitFor("cart-total", (s) => s.closingRecord !== undefined);

    // The inbox item follows the record's save.
    await expect
      .poll(async () =>
        (await world.manager.inbox("cart-total", { all: true })).items.some(
          (i) => i.file === BUILD_CLOSING_RECORD,
        ),
      )
      .toBe(true);
    const inbox = await world.manager.inbox("cart-total", { all: true });
    expect(inbox.items).toContainEqual(
      expect.objectContaining({
        kind: "digest",
        file: BUILD_CLOSING_RECORD,
        needsAnswer: false,
      }),
    );
    expect(world.events.ofType("build.inbox").map((e) => e.item.file)).toContain(
      BUILD_CLOSING_RECORD,
    );
  });

  it("writes the engine's closing record when the Scribe can't", async () => {
    const world = await buildWorld();
    world.script({ claude: [SLOW_DEVELOPER] });
    await startIn(world, "cart-total", "box-a");
    await agentStarted(world);

    await world.manager.cancel("cart-total");
    await world.waitFor("cart-total", (s) => s.closingRecord !== undefined);
    const record = world.file("cart-total", BUILD_CLOSING_RECORD);
    expect(record).toMatch(/cancelled the build at the tasks step/i);
    expect(record).toMatch(/The Scribe couldn't write/);
  });

  it("resumes a cancelled build on request", async () => {
    const world = await buildWorld();
    world.script({ claude: [SLOW_DEVELOPER], codex: [CLOSING] });
    await startIn(world, "cart-total", "box-a");
    await agentStarted(world);
    await world.manager.cancel("cart-total");

    world.script({ claude: [DEVELOPER], codex: [CLOSING] });
    const resumed = await world.manager.resume("cart-total");
    expect(resumed.status).toBe("running");
    const state = await world.waitFor("cart-total", (s) => s.step === "review");
    expect(state.tasks[0]).toMatchObject({ status: "done" });
    // The engine writes the status file right after the state file.
    await world.waitFor("cart-total", () =>
      world.file("cart-total", "STATUS.md").includes("- Step: review"),
    );
  });

  it("deletes the branch and worktree and keeps the build's record", async () => {
    const world = await buildWorld();
    world.script({ claude: [SLOW_DEVELOPER], codex: [CLOSING] });
    const started = await startIn(world, "cart-total", "box-a");
    await agentStarted(world);
    await expect(world.manager.delete("cart-total")).rejects.toMatchObject({
      code: "invalid_state",
    });

    await world.manager.cancel("cart-total");
    await world.waitFor("cart-total", (s) => s.closingRecord !== undefined);
    const deleted = await world.manager.delete("cart-total");
    expect(deleted.deletedAt).toBeDefined();
    // The server and the apps learn of the delete from the build's summary.
    const shown = world.events.ofType("build.changed").filter((e) => e.build.id === started.id);
    expect(shown.at(-1)?.build.deletedAt).toBe(deleted.deletedAt);
    expect(existsSync(started.worktree)).toBe(false);
    expect(world.git(world.root, "branch", "--list", "build/cart-total")).toBe("");
    expect(world.file("cart-total", BUILD_CLOSING_RECORD)).toMatch(/cancelled/i);
    expect(world.file("cart-total", "plan.json")).toContain("cart");

    await expect(world.manager.resume("cart-total")).rejects.toMatchObject({
      code: "invalid_state",
    });
    await world.restart();
    expect(await world.manager.get("cart-total")).toMatchObject({
      status: "cancelled",
      deletedAt: deleted.deletedAt,
    });
  });
});

describe("a build's review run", () => {
  /** A review that takes a while, then finds nothing. */
  const SLOW_REVIEW: MockResponse[] = [
    DEVELOPER,
    { match: "Review file group", delayMs: 1500, output: { findings: [] } },
    { output: { findings: [] } },
  ];

  async function inReview(world: BuildWorld): Promise<string> {
    world.script({ claude: SLOW_REVIEW, codex: [CLOSING, ...SLOW_REVIEW] });
    await startIn(world, "cart-total", "box-a");
    await world.waitFor("cart-total", () => world.jsonFiles("cart-total", "review").length === 1);
    const [record] = world.jsonFiles("cart-total", "review") as { runId: string }[];
    const runId = record?.runId ?? "";
    await waitForRun(world, runId, (s) => s === "running");
    return runId;
  }

  async function waitForRun(
    world: BuildWorld,
    runId: string,
    done: (status: string) => boolean,
  ): Promise<string> {
    const end = Date.now() + 30_000;
    const seen: string[] = [];
    while (Date.now() < end) {
      const status = (await world.runs.get(runId))?.status ?? "missing";
      if (seen.at(-1) !== status) seen.push(status);
      if (done(status)) return status;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `run ${runId} didn't reach the status; seen: ${seen.join(", ")}; last: ${JSON.stringify(await world.runs.get(runId))}`,
    );
  }

  it("pauses and resumes with the build", async () => {
    const world = await buildWorld({ review: true });
    const runId = await inReview(world);

    await world.manager.pause("cart-total", "box");
    await waitForRun(world, runId, (s) => s === "paused");

    await world.manager.resume("cart-total", "box");
    await waitForRun(world, runId, (s) => s !== "paused");
    await world.waitFor("cart-total", (s) => s.step === "release_ready" && s.status === "paused");
    expect((await world.runs.get(runId))?.status).toBe("finished");
  });

  it("is cancelled with the build, and a resumed build starts a new one", async () => {
    const world = await buildWorld({ review: true });
    const runId = await inReview(world);

    await world.manager.cancel("cart-total");
    expect(await waitForRun(world, runId, (s) => s === "cancelled")).toBe("cancelled");
    await world.waitFor("cart-total", (s) => s.closingRecord !== undefined);

    await world.manager.resume("cart-total");
    await world.waitFor("cart-total", (s) => s.step === "release_ready" && s.status === "paused");
    const [record] = world.jsonFiles("cart-total", "review") as { runId: string }[];
    expect(record?.runId).not.toBe(runId);
  });
});
