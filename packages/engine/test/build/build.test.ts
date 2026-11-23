// A one-task build through the engine build API, with the mock vendor CLIs.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CART_DONE, CART_WRONG, PROJECT_ID, REPORT, buildWorld, cartPlan } from "./harness.js";

describe("a one-task build", () => {
  it("reaches the review step with the Developer's commit on the build branch", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });

    const started = await world.start("cart-total");
    expect(started).toMatchObject({ slug: "cart-total", branch: "build/cart-total" });
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(state.tasks).toEqual([
      expect.objectContaining({ id: "T1", status: "done", attempts: 1 }),
    ]);
    const tip = world.git(world.root, "rev-parse", "build/cart-total");
    expect(state.tasks[0]?.commit).toBe(tip);
    expect(world.git(world.root, "show", "build/cart-total:src/cart.mjs")).toBe(CART_DONE.trim());
    expect(world.git(world.root, "rev-list", "--count", "main..build/cart-total")).toBe("1");
    expect(world.calls().map((c) => c.cli)).toEqual(["claude"]);
    expect(world.file("cart-total", "STATUS.md")).toMatch(/review/i);
  });

  it("sends the build's events, with the build, seat, and step on its calls", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });

    const started = await world.start("cart-total");
    await world.settle("cart-total");

    const events = world.events.events;
    expect(events[0]).toMatchObject({
      type: "build.changed",
      build: { id: started.id, slug: "cart-total", projectId: PROJECT_ID, status: "running" },
    });
    expect(world.events.ofType("agent.started")).toEqual([
      expect.objectContaining({
        runId: null,
        buildId: started.id,
        seat: "developer",
        step: "tasks",
        role: "fixer",
      }),
    ]);
    expect(world.broker.requests).toEqual([
      expect.objectContaining({ runId: null, buildId: started.id, seat: "developer" }),
    ]);
    expect(world.events.ofType("build.task.changed").map((e) => e.status)).toEqual([
      "running",
      "done",
    ]);
    expect(world.events.ofType("build.changed").at(-1)?.build).toMatchObject({
      status: "paused",
      step: "review",
    });
    const saved = world
      .file("cart-total", "events.jsonl")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(saved).toEqual(events.map((e) => e.type));
  });

  it("leaves the project's own checkout untouched", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });
    const head = world.git(world.root, "rev-parse", "HEAD");

    await world.start("cart-total");
    await world.settle("cart-total");

    expect(world.git(world.root, "rev-parse", "HEAD")).toBe(head);
    expect(world.git(world.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(world.git(world.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});

interface SavedAttempt {
  gate: {
    passed: boolean;
    permission: { passed: boolean; outside: string[] };
    commands: { kind: string; passed: boolean }[];
  };
}

const TYPECHECK = {
  command: `node -e "process.exit(require('fs').readFileSync('src/cart.mjs','utf8').includes('TYPE ERROR') ? 1 : 0)"`,
};

describe("the task gate", () => {
  it.each([
    ["test", CART_WRONG],
    ["typecheck", `${CART_DONE}// TYPE ERROR\n`],
    ["lint", `${CART_DONE}console.log("debug");\n`],
  ])("fails an attempt whose %s command fails", async (kind, content) => {
    const world = await buildWorld();
    world.script({
      claude: [
        { match: "attempt 1 of", output: REPORT, writeFiles: { "src/cart.mjs": content } },
        { match: "attempt 2 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
      ],
    });
    const plan = cartPlan();
    plan.commands = { ...plan.commands, typecheck: [TYPECHECK] };

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 2 });
    const [first, second] = world.jsonFiles("cart-total", "tasks/T1") as SavedAttempt[];
    expect(first?.gate.passed).toBe(false);
    expect(first?.gate.commands.filter((c) => !c.passed).map((c) => c.kind)).toEqual([kind]);
    expect(second?.gate.passed).toBe(true);
    expect(world.calls()[1]?.prompt).toContain(`${kind} command`);
  });

  it("fails an attempt that changes a file outside the role's writable paths, and puts it back", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        {
          match: "attempt 1 of",
          output: REPORT,
          writeFiles: { "src/cart.mjs": CART_DONE, "README.md": "# Changed\n", "notes.txt": "x\n" },
        },
        { match: "attempt 2 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
      ],
    });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 2 });
    const [first] = world.jsonFiles("cart-total", "tasks/T1") as SavedAttempt[];
    expect(first?.gate.permission).toMatchObject({
      passed: false,
      outside: ["README.md", "notes.txt"],
    });
    expect(first?.gate.commands.every((c) => c.passed)).toBe(true);
    expect(world.git(world.root, "show", "build/cart-total:README.md")).toBe("# Shop");
    expect(world.git(world.root, "ls-tree", "--name-only", "build/cart-total")).not.toContain(
      "notes.txt",
    );
  });
});

describe("the attempt cap", () => {
  it("escalates a task that fails four attempts, and the build waits with that state", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_WRONG } }],
    });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ status: "waiting_escalation", step: "tasks" });
    expect(state.tasks[0]).toMatchObject({ status: "failed", attempts: 4 });
    expect(world.calls()).toHaveLength(4);
    const [escalation] = world.jsonFiles("cart-total", "escalations") as Record<string, unknown>[];
    expect(escalation).toMatchObject({
      id: "E1",
      kind: "attempt_cap",
      level: "project_manager",
      taskId: "T1",
      details: expect.stringContaining("node test/cart.test.mjs"),
    });
    expect(state.escalations).toEqual([
      expect.objectContaining({ id: "E1", file: "escalations/E1.json" }),
    ]);
    const status = world.file("cart-total", "STATUS.md");
    expect(status).toContain("waiting_escalation");
    expect(status).toContain("escalations/E1.json");
    expect(world.git(world.root, "rev-parse", "build/cart-total")).toBe(
      world.git(world.root, "rev-parse", "main"),
    );
  });
});

describe("build requests", () => {
  it("pauses a build after its current agent call and resumes it", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        {
          match: "Task T1",
          delayMs: 1500,
          output: REPORT,
          writeFiles: { "src/cart.mjs": CART_DONE },
        },
      ],
    });
    await world.start("cart-total");
    await world.waitFor("cart-total", () =>
      world.events.events.some((e) => e.type === "agent.started"),
    );

    const paused = await world.manager.pause("cart-total");
    expect(paused.status).toBe("paused");
    // The agent call finishes, and the build holds before the gate.
    await world.waitFor("cart-total", () => world.jsonFiles("cart-total", "calls").length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect((await world.manager.get("cart-total"))?.status).toBe("paused");
    expect(world.file("cart-total", "STATUS.md")).toContain("Status: paused");

    await world.manager.resume("cart-total");
    const state = await world.waitFor("cart-total", (s) => s.step === "review");
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(world.calls()).toHaveLength(1);
  });

  it("refuses a second build with the same name, and reads an unknown build as missing", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });
    await world.start("cart-total");
    await expect(world.start("cart-total")).rejects.toMatchObject({ code: "conflict" });
    expect(await world.manager.get("no-such-build")).toBeNull();
    await expect(world.manager.pause("no-such-build")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("an engine restart", () => {
  it("continues the build from its last finished step without repeating the agent call", async () => {
    const world = await buildWorld();
    const hold = join(world.root, "..", `hold-${Date.now()}`);
    const started = join(world.root, "..", `gate-started-${Date.now()}`);
    writeFileSync(hold, "");
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });
    const plan = cartPlan();
    // The test command holds the gate while the hold file exists.
    plan.commands = {
      ...plan.commands,
      test: [
        {
          command: `touch ${started}; while [ -e ${hold} ]; do sleep 0.05; done; node test/cart.test.mjs`,
        },
      ],
    };
    await world.start("cart-total", plan);
    await world.waitFor("cart-total", () => existsSync(started));

    await world.restart();
    rmSync(hold);
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(world.calls()).toHaveLength(1);
    expect(world.git(world.root, "show", "build/cart-total:src/cart.mjs")).toBe(CART_DONE.trim());
  });
});

describe("escalations from agent calls", () => {
  it("escalates a task whose agent call fails twice", async () => {
    const world = await buildWorld();
    world.script({ claude: [{ match: "Task T1", error: "crash" }] });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ status: "waiting_escalation" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "agent_call", taskId: "T1", level: "project_manager" }),
    ]);
  });

  it("escalates a seat whose placement breaks the single-vendor setting, and calls no vendor", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });

    await world.start(
      "cart-total",
      cartPlan({ singleVendor: "claude", placements: { developer: { vendor: "codex" } } }),
    );
    const state = await world.settle("cart-total");

    expect(state.escalations).toEqual([expect.objectContaining({ kind: "placement" })]);
    expect(world.calls()).toHaveLength(0);
  });

  it("places the Developer on the build plan's placement", async () => {
    const world = await buildWorld();
    world.script({
      codex: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });

    await world.start("cart-total", cartPlan({ placements: { developer: { vendor: "codex" } } }));
    const state = await world.settle("cart-total");

    expect(state.tasks[0]).toMatchObject({ status: "done" });
    expect(world.calls().map((c) => c.cli)).toEqual(["codex"]);
  });
});
