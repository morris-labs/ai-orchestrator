// The `aio-build` command, over a real build socket with a fake build manager.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_SOCKET_ROUTES } from "@aio/contracts";
import { EngineError } from "../../src/api/core-interface.js";
import { BUILD_USAGE, buildMain } from "../../src/build-socket/cli.js";
import { serveBuildSocket, type BuildSocketServer } from "../../src/build-socket/server.js";
import { silentLogger } from "../../src/main/logger.js";
import { buildState, fakeBuildManager, freezeAnswer, seatAnswer } from "../api/fixtures.js";
import { tempDir } from "../tmp.js";
import { PLAN } from "./helpers.js";

let server: BuildSocketServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function world(projectId = "proj-1") {
  const dir = tempDir("aio-bcli-");
  const socket = join(dir, "build.sock");
  const builds = fakeBuildManager();
  server = await serveBuildSocket({ path: socket, builds, projectId, log: silentLogger });
  const planFile = join(dir, "plan.json");
  writeFileSync(planFile, JSON.stringify(PLAN));
  const briefFile = join(dir, "brief.md");
  writeFileSync(briefFile, "Add a total to the cart.\n");
  const env: Record<string, string | undefined> = {
    AIO_BUILD_SOCKET: socket,
    AIO_PROJECT_ID: "proj-1",
    AIO_BOX_ID: "box-1",
  };
  const run = async (argv: string[], over: Record<string, string | undefined> = {}) => {
    let stdout = "";
    let stderr = "";
    const code = await buildMain(argv, {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      env: { ...env, ...over },
    });
    return { code, stdout, stderr };
  };
  return { builds, planFile, briefFile, run, dir, socket };
}

describe("aio-build", () => {
  it("starts a build from a plan file and prints its state", async () => {
    const { builds, planFile, run } = await world();
    const out = await run(["start", "cart-total", planFile, "--base", "main"]);
    expect(out.code).toBe(0);
    expect(builds.start).toHaveBeenCalledWith({
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      plan: expect.objectContaining({ title: "Add a total to the cart" }),
      base: "main",
    });
    expect(out.stdout).toContain("Build cart-total: running, step tasks");
    expect(out.stdout).toContain("T1");
    expect(out.stdout).toContain(".aio/builds/cart-total/STATUS.md");
  });

  it("names the Claude Code session behind each request, so the engine can read its transcript", async () => {
    const { builds, run } = await world();
    const id = "8f1c2d3e-0000-4000-8000-000000000001";
    expect(
      (
        await run(["status", "cart-total"], {
          CLAUDE_CODE_SESSION_ID: id,
          CLAUDE_CONFIG_DIR: "/cfg/dev",
        })
      ).code,
    ).toBe(0);
    expect(builds.noteSession).toHaveBeenLastCalledWith("cart-total", "box-1", {
      id,
      transcripts: "/cfg/dev/projects",
    });
    await run(["status", "cart-total"], { CLAUDE_CODE_SESSION_ID: id, HOME: "/home/dev" });
    expect(builds.noteSession).toHaveBeenLastCalledWith("cart-total", "box-1", {
      id,
      transcripts: "/home/dev/.claude/projects",
    });
    builds.noteSession.mockClear();
    await run(["status", "cart-total"]);
    expect(builds.noteSession).not.toHaveBeenCalled();
  });

  it("prints the build state as JSON with --json", async () => {
    const { planFile, run } = await world();
    const out = await run(["start", "cart-total", planFile, "--json"]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(buildState);
  });

  it("reads, pauses, and resumes a build", async () => {
    const { builds, run } = await world();
    expect((await run(["status", "cart-total"])).stdout).toContain("running");
    const paused = await run(["pause", "cart-total"]);
    expect(paused.code).toBe(0);
    expect(paused.stdout).toContain("Build cart-total: paused");
    expect(builds.pause).toHaveBeenCalledWith("cart-total", "owner");
    expect((await run(["resume", "cart-total"])).code).toBe(0);
    expect(builds.resume).toHaveBeenCalledWith("cart-total", "owner");
  });

  it("prints the planning record of a build that is still in planning", async () => {
    const { run } = await world();
    const res = await run(["status", "in-planning"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Build in-planning: planning");
    expect(res.stdout).toContain("analyst 1: done");
    expect(res.stdout).toContain("planning/draft.json");
    const json = await run(["status", "in-planning", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ slug: "in-planning", version: 1 });
  });

  it("cancels a build and points to its closing record", async () => {
    const { builds, run } = await world();
    builds.cancel.mockResolvedValue({
      ...buildState,
      status: "cancelled",
      closingRecord: "closing-record.md",
    });
    const out = await run(["cancel", "cart-total"]);
    expect(out.code).toBe(0);
    expect(builds.cancel).toHaveBeenCalledWith("cart-total");
    expect(out.stdout).toContain("Build cart-total: cancelled");
    expect(out.stdout).toContain(".aio/builds/cart-total/closing-record.md");
  });

  it("refuses to control another box's build with the refusal's exit status", async () => {
    const { builds, run } = await world();
    builds.get.mockResolvedValue({ ...buildState, boxId: "box-2" });
    const out = await run(["cancel", "cart-total"]);
    expect(out.code).toBe(5);
    expect(out.stderr).toContain("box-2");
    expect(builds.cancel).not.toHaveBeenCalled();
  });

  it("resolves an escalation with each kind of resolution", async () => {
    const { builds, run } = await world();
    const resolve = async (args: string[]) => {
      builds.resolve.mockClear();
      const out = await run(["resolve", "cart-total", "E1", ...args]);
      expect(out.code).toBe(0);
      return builds.resolve.mock.calls[0]?.[1] as Record<string, unknown>;
    };

    expect(await resolve(["retry"])).toEqual({
      escalation: "E1",
      action: "retry",
      by: "project_manager",
      changes: [],
    });
    expect(await resolve(["reorder", "--order", "T2,T1"])).toMatchObject({ order: ["T2", "T1"] });
    expect(await resolve(["clarify", "--note", "Prices are in cents."])).toMatchObject({
      action: "clarify",
      note: "Prices are in cents.",
    });
    expect(
      await resolve(["decide", "--decision", "resume_waive", "--waive", "F-1,F-2"]),
    ).toMatchObject({
      decision: { option: "resume_waive", waiveFindingIds: ["F-1", "F-2"] },
    });
    expect(await resolve(["retry", "--owner", "--push", "no"])).toMatchObject({
      by: "owner",
      push: false,
    });
    expect(
      await resolve(["clarify", "--note", "Drop AC3.", "--changes", "criteria,scope"]),
    ).toMatchObject({
      changes: ["criteria", "scope"],
    });
    expect(await resolve(["retry", "--own", "src/api.ts,test/routes.test.ts"])).toMatchObject({
      action: "retry",
      own: ["src/api.ts", "test/routes.test.ts"],
    });
    expect(
      await resolve(["retry", "--engine-defect", "--note", "The gate reads the wrong file."]),
    ).toMatchObject({
      action: "retry",
      cause: "engine_defect",
      note: "The gate reads the wrong file.",
    });
    expect(builds.resolve.mock.calls[0]?.[0]).toBe("cart-total");
  });

  it("prints an engine defect pause and its note", async () => {
    const { builds, run } = await world();
    builds.resolve.mockResolvedValueOnce({
      ...buildState,
      status: "paused",
      pausedBy: "engine_defect",
      escalations: [
        {
          id: "E1",
          kind: "attempt_cap",
          level: "project_manager",
          taskId: "T1",
          tasks: ["T1"],
          summary: "Task T1 failed the task gate on all 4 attempts.",
          file: "escalations/E1.json",
          status: "resolved",
          defectNote: "engine-defects/E1.md",
          resolution: {
            action: "retry",
            by: "project_manager",
            note: "The gate reads the wrong file.",
            cause: "engine_defect",
            changes: [],
            resolvedAt: "2026-01-01T00:00:00.000Z",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const out = await run([
      "resolve",
      "cart-total",
      "E1",
      "retry",
      "--engine-defect",
      "--note",
      "x",
    ]);

    expect(out.stdout).toContain("Paused by: an engine defect, see engine-defects/E1.md");
  });

  it("prints each escalation's status and the tasks it pauses", async () => {
    const { builds, run } = await world();
    builds.resolve.mockResolvedValueOnce({
      ...buildState,
      status: "waiting_escalation",
      escalations: [
        {
          id: "E1",
          kind: "attempt_cap",
          level: "project_manager",
          taskId: "T1",
          tasks: ["T1", "T2"],
          summary: "Task T1 failed the task gate on all 4 attempts.",
          file: "escalations/E1.json",
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "E2",
          kind: "preflight",
          level: "owner",
          taskId: null,
          tasks: [],
          summary: "A test command can't run.",
          file: "escalations/E2.json",
          status: "resolved",
          resolution: {
            action: "retry",
            by: "owner",
            changes: [],
            resolvedAt: "2026-01-01T00:00:00.000Z",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const out = await run(["resolve", "cart-total", "E2", "retry", "--owner"]);

    expect(out.stdout).toContain("E1  open, pauses T1, T2  project_manager  attempt_cap T1:");
    expect(out.stdout).toContain("E2  resolved by the owner: retry  owner  preflight:");
  });

  it("refuses a resolve request without an escalation or with an unknown action", async () => {
    const { run } = await world();
    expect((await run(["resolve", "cart-total"])).code).toBe(2);
    expect((await run(["resolve", "cart-total", "E1", "skip"])).stderr).toContain(
      "skip isn't a resolution",
    );
    expect((await run(["status", "cart-total", "--owner"])).code).toBe(2);
  });

  it("prints the direct messages and the decisions for the Project manager", async () => {
    const { builds, run } = await world();
    const direct = await run(["messages", "cart-total", "--direct"]);
    expect(direct.code).toBe(0);
    expect(builds.messages).toHaveBeenCalledWith("cart-total", { direct: true });
    expect(direct.stdout).toContain("M1  developer (T1) -> owner  note  T1");
    expect(direct.stdout).toContain("  The criteria miss an empty cart.");
    const all = await run(["messages", "cart-total", "--json"]);
    expect(JSON.parse(all.stdout)).toHaveLength(2);
    const decisions = await run(["decisions", "cart-total"]);
    expect(decisions.code).toBe(0);
    expect(decisions.stdout).toContain("D1  owner post M2 to developer (T1)");
    expect(decisions.stdout).toContain("Plan change: contradicts AC1");
    const wrong = await run(["status", "cart-total", "--direct"]);
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain("status doesn't take --direct");
  });

  it("prints the Project manager inbox", async () => {
    const { builds, run } = await world();
    const out = await run(["inbox", "cart-total"]);
    expect(out.code).toBe(0);
    expect(builds.inbox).toHaveBeenCalledWith("cart-total", { all: false });
    expect(out.stdout).toContain("I1  escalation E1  delivered, waits for an answer  2026-");
    expect(out.stdout).toContain("  Read /work/shop/.aio/builds/cart-total/escalations/E1.json");
    await run(["inbox", "cart-total", "--all"]);
    expect(builds.inbox).toHaveBeenLastCalledWith("cart-total", { all: true });
    const json = await run(["inbox", "cart-total", "--json"]);
    expect(JSON.parse(json.stdout)).toHaveLength(1);
    expect((await run(["status", "cart-total", "--all"])).stderr).toContain(
      "status doesn't take --all",
    );
  });

  it("calls a planning seat with a brief and an issue and prints its answer", async () => {
    const { builds, briefFile, run } = await world();
    const out = await run([
      "plan",
      "cart-total",
      "analyst",
      briefFile,
      "--issue",
      "example/shop#42",
    ]);
    expect(out.code).toBe(0);
    expect(builds.plan).toHaveBeenCalledWith({
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      seat: "analyst",
      brief: "Add a total to the cart.\n",
      issue: {
        repository: "example/shop",
        number: 42,
        url: "https://github.com/example/shop/issues/42",
      },
    });
    expect(out.stdout).toContain("The analyst answered build cart-total (call 1)");
    expect(out.stdout).toContain(".aio/builds/cart-total/planning/analyst-1.json");
    expect(out.stdout).toContain('"size": "small"');
  });

  it("takes an issue as a link", async () => {
    const { builds, briefFile, run } = await world();
    const link = "https://git.example.com/example/shop/issues/7";
    expect((await run(["plan", "cart-total", "architect", briefFile, "--issue", link])).code).toBe(
      0,
    );
    expect(builds.plan.mock.calls[0]![0].issue).toEqual({
      repository: "example/shop",
      number: 7,
      url: link,
    });
  });

  it("opens a meeting with its members and round cap and prints the outcome", async () => {
    const { builds, briefFile, run } = await world();
    const out = await run([
      "meet",
      "cart-total",
      briefFile,
      "--members",
      "critic,analyst",
      "--proposer",
      "architect",
      "--rounds",
      "2",
    ]);
    expect(out.code).toBe(0);
    expect(builds.meet).toHaveBeenCalledWith({
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      brief: "Add a total to the cart.\n",
      members: ["critic", "analyst"],
      proposer: "architect",
      rounds: 2,
    });
    expect(out.stdout).toContain(
      "Meeting meeting-1 of build cart-total: round_cap after 1 of 1 rounds",
    );
    expect(out.stdout).toContain("critic: No task covers an empty cart.");
    expect(out.stdout).toContain(".aio/builds/cart-total/meetings/meeting-1.json");
  });

  it("relays an owner post to a meeting", async () => {
    const { builds, briefFile, run } = await world();
    const out = await run(["meeting-post", "cart-total", "meeting-1", briefFile, "--json"]);
    expect(out.code).toBe(0);
    expect(builds.meetingPost).toHaveBeenCalledWith({
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      meeting: "meeting-1",
      body: "Add a total to the cart.\n",
    });
    expect(JSON.parse(out.stdout).meeting.id).toBe("meeting-1");
  });

  it("ends a meeting early", async () => {
    const { builds, run } = await world();
    const out = await run(["meeting-end", "cart-total", "meeting-1"]);
    expect(out.code).toBe(0);
    expect(builds.meetingEnd).toHaveBeenCalledWith({
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      meeting: "meeting-1",
    });
    expect(out.stdout).toContain("Meeting meeting-1 of build cart-total:");
  });

  it("freezes the draft plan with the push answer", async () => {
    const { builds, run } = await world();
    const out = await run(["freeze", "cart-total", "--push", "yes"]);
    expect(out.code).toBe(0);
    expect(builds.freeze).toHaveBeenCalledWith({
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      push: true,
    });
    expect(out.stdout).toContain("Froze build cart-total's plan as version 1");
    expect(out.stdout).toContain(".aio/builds/cart-total/plans/v1.json");
    expect(out.stdout).toContain("Push: allowed");
  });

  it("freezes with the owner's flow choice and prints it", async () => {
    const { builds, run } = await world();
    builds.freeze.mockResolvedValueOnce({
      ...freezeAnswer,
      frozen: { ...freezeAnswer.frozen, flow: "single_session" },
    });
    const out = await run(["freeze", "cart-total", "--push", "no", "--flow", "single-session"]);
    expect(out.code).toBe(0);
    expect(builds.freeze.mock.calls[0]![0]).toMatchObject({ push: false, flow: "single_session" });
    expect(out.stdout).toContain("Flow: single session");
    await run(["freeze", "cart-total", "--push", "no", "--flow", "pipeline"]);
    expect(builds.freeze.mock.calls[1]![0]).toMatchObject({ flow: "pipeline" });
  });

  it("prints the Analyst's recommendation and each frozen version's flow in a planning status", async () => {
    const { builds, run } = await world();
    builds.get.mockResolvedValueOnce(null);
    builds.planning.mockResolvedValueOnce({
      ...freezeAnswer.planning,
      recommendation: { flow: "pipeline", highRisk: true, reason: "It runs a migration." },
    });
    const out = await run(["status", "cart-total"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Recommended flow: pipeline (high-risk). It runs a migration.");
    expect(out.stdout).toContain("Frozen plan: version 1, flow pipeline");
  });

  it("freezes a plan file and prints the answer as JSON with --json", async () => {
    const { builds, planFile, run } = await world();
    const out = await run(["freeze", "cart-total", planFile, "--push", "no", "--json"]);
    expect(out.code).toBe(0);
    expect(builds.freeze.mock.calls[0]![0]).toMatchObject({ plan: PLAN, push: false });
    expect(JSON.parse(out.stdout)).toEqual(freezeAnswer);
  });

  it("passes on the engine's message for a freeze without the push answer", async () => {
    const { builds, run } = await world();
    builds.freeze.mockRejectedValueOnce(
      new EngineError("validation", "The freeze needs the owner's push answer. Ask the owner."),
    );
    const out = await run(["freeze", "cart-total"]);
    expect(out.code).toBe(5);
    expect(out.stderr).toContain("Ask the owner");
  });

  it("starts a build from its frozen plan without a plan file", async () => {
    const { builds, run } = await world();
    expect((await run(["start", "cart-total"])).code).toBe(0);
    expect(builds.start.mock.calls[0]![0]).not.toHaveProperty("plan");
  });

  it("prints a seat's whole answer as JSON with --json", async () => {
    const { briefFile, run } = await world();
    const out = await run(["plan", "cart-total", "analyst", briefFile, "--json"]);
    expect(JSON.parse(out.stdout)).toEqual(seatAnswer);
  });

  it("sends a null box outside a box session", async () => {
    const { builds, planFile, run } = await world();
    expect((await run(["start", "cart-total", planFile], { AIO_BOX_ID: undefined })).code).toBe(0);
    expect(builds.start.mock.calls[0]![0]).not.toHaveProperty("boxId");
  });

  it("refuses to run without the project ID", async () => {
    const { builds, run } = await world();
    const out = await run(["status", "cart-total"], { AIO_PROJECT_ID: undefined });
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("AIO_PROJECT_ID");
    expect(builds.get).not.toHaveBeenCalled();
  });

  it("can't reach another project's builds", async () => {
    const { builds, run } = await world("proj-1");
    const out = await run(["pause", "cart-total"], { AIO_PROJECT_ID: "proj-2" });
    expect(out.code).toBe(4);
    expect(out.stderr).toContain("has no build cart-total");
    expect(builds.pause).not.toHaveBeenCalled();
  });

  it("explains a plan the engine refuses", async () => {
    const { planFile, run } = await world();
    writeFileSync(planFile, JSON.stringify({ ...PLAN, tasks: [] }));
    const out = await run(["start", "cart-total", planFile]);
    expect(out.code).toBe(5);
    expect(out.stderr).toMatch(/plan\.tasks/);
  });

  it("reports a conflict and an unknown build with their own exit statuses", async () => {
    const { builds, planFile, run } = await world();
    builds.start.mockRejectedValueOnce(new EngineError("conflict", "A build named x exists."));
    const conflict = await run(["start", "cart-total", planFile]);
    expect(conflict).toMatchObject({ code: 5, stderr: "aio-build: A build named x exists.\n" });
    expect((await run(["status", "no-such-build"])).code).toBe(4);
  });

  it("reports an unreadable plan file and an unreachable socket", async () => {
    const { dir, run } = await world();
    const missing = await run(["start", "cart-total", join(dir, "nope.json")]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("nope.json");
    writeFileSync(join(dir, "bad.json"), "{");
    expect((await run(["start", "cart-total", join(dir, "bad.json")])).code).toBe(2);
    const down = await run(["status", "cart-total"], { AIO_BUILD_SOCKET: join(dir, "none.sock") });
    expect(down.code).toBe(3);
    expect(down.stderr).toContain("build socket");
  });

  it.each([
    [[]],
    [["start", "cart-total", "a", "b"]],
    [["plan", "cart-total", "analyst"]],
    [["plan", "cart-total", "Analyst", "brief.md"]],
    [["plan", "cart-total", "analyst", "brief.md", "--issue", "shop#1"]],
    [["freeze", "cart-total", "--push", "maybe"]],
    [["freeze", "cart-total", "--flow", "solo"]],
    [["start", "cart-total", "--flow", "pipeline"]],
    [["meet", "cart-total", "brief.md", "--rounds", "0"]],
    [["meet", "cart-total", "brief.md", "--members", "Critic"]],
    [["meeting-post", "cart-total", "meeting-x", "post.md"]],
    [["meeting-end", "cart-total"]],
    [["meeting-end", "cart-total", "meeting-x"]],
    [["meet", "cart-total", "brief.md", "--push", "yes"]],
    [["freeze", "cart-total", "--issue", "example/shop#1"]],
    [["status", "cart-total", "--push", "yes"]],
    [["start", "Bad Slug", "plan.json"]],
    [["status"]],
    [["status", "a", "b"]],
    [["pause", "cart-total", "--base", "main"]],
    [["resolve", "cart-total", "E1", "retry", "extra"]],
    [["resolve", "cart-total", "E1", "clarify", "--note"]],
    [["resolve", "cart-total", "E1", "retry", "--push", "maybe"]],
    [["start", "cart-total", "--note", "Hi."]],
    [["frobnicate"]],
  ])("refuses the usage %j", async (argv) => {
    const { run } = await world();
    const out = await run(argv);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("Usage:");
  });

  it("documents each request in its help", async () => {
    const { run } = await world();
    const out = await run(["--help"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(BUILD_USAGE);
    for (const kind of Object.keys(BUILD_SOCKET_ROUTES)) {
      expect(BUILD_USAGE).toMatch(new RegExp(`^  ${kind}\\b`, "m"));
    }
    for (const fact of [
      "BRIEF_FILE",
      "--issue",
      "--push",
      "ask the owner",
      "ESCALATION",
      "--owner",
      "--changes",
      "PLAN_FILE",
      "--base",
      "--json",
      "--direct",
      "AIO_PROJECT_ID",
      "AIO_BOX_ID",
      "Exit status",
    ]) {
      expect(BUILD_USAGE).toContain(fact);
    }
  });
});
