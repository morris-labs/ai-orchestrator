import type { AioEvent, BuildSummary } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { BuildMirror } from "../../src/events/build-mirror.js";
import { engineEventRefusal } from "../../src/events/engines.js";
import { RunMirror } from "../../src/events/run-mirror.js";
import { CONTAINER, PROJECT_ID, RUN, runState } from "../api/fixtures.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const OTHER_BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2R";
const OTHER_PROJECT = "other-app-9f8e7d6c";
const endpoint = { container: CONTAINER, projectId: PROJECT_ID };
const T0 = "2026-10-28T09:00:00.000Z";
const T1 = "2026-10-28T09:05:00.000Z";

const summary: BuildSummary = {
  id: BUILD,
  slug: "add-export",
  projectId: PROJECT_ID,
  container: CONTAINER,
  status: "running",
  step: "tasks",
  boxId: null,
  createdAt: T0,
  updatedAt: T0,
};

let seq = 0;
const ev = (event: Record<string, unknown>) => {
  seq += 1;
  return {
    id: `e${seq}`,
    time: T0,
    source: `engine:${CONTAINER}`,
    streamId: "S",
    seq,
    sourceSeq: seq,
    ...event,
  } as AioEvent;
};

const buildChanged = (build: Partial<BuildSummary> = {}) =>
  ev({ type: "build.changed", build: { ...summary, ...build } });

const buildAgent = (owner: Record<string, unknown>) =>
  ev({
    type: "agent.started",
    agentId: "A1",
    leaseId: "L1",
    vendor: "claude",
    model: "claude-sonnet-5",
    role: "fixer",
    groupId: null,
    round: 1,
    ...owner,
  });

function seeded() {
  const db = openDatabase(":memory:");
  new RunMirror(db).upsert(runState);
  const builds = new BuildMirror(db);
  return { db, builds };
}

describe("build event admission", () => {
  it("accepts a build.changed event for the engine's own project and container", () => {
    const { db } = seeded();
    expect(engineEventRefusal(db, endpoint, buildChanged())).toBeNull();
  });

  it("refuses a build.changed event for another project or container", () => {
    const { db } = seeded();
    expect(engineEventRefusal(db, endpoint, buildChanged({ projectId: OTHER_PROJECT }))).toMatch(
      OTHER_PROJECT,
    );
    expect(
      engineEventRefusal(db, endpoint, buildChanged({ container: "aio-agent-proj-other" })),
    ).not.toBeNull();
  });

  it("refuses to move a stored build to another project", () => {
    const { db, builds } = seeded();
    builds.upsert({ ...summary, projectId: OTHER_PROJECT, container: "aio-agent-proj-other" });
    expect(engineEventRefusal(db, endpoint, buildChanged())).toMatch(OTHER_PROJECT);
  });

  it("accepts a build's task and agent events once the build is known", () => {
    const { db, builds } = seeded();
    const task = ev({
      type: "build.task.changed",
      buildId: BUILD,
      taskId: "T1",
      status: "running",
      previousStatus: "pending",
    });
    const agent = buildAgent({ runId: null, buildId: BUILD, seat: "developer", step: "tasks" });
    expect(engineEventRefusal(db, endpoint, task)).toMatch(/unknown/);
    expect(engineEventRefusal(db, endpoint, agent)).toMatch(/unknown/);
    builds.ingest(buildChanged());
    expect(engineEventRefusal(db, endpoint, task)).toBeNull();
    expect(engineEventRefusal(db, endpoint, agent)).toBeNull();
  });

  it("accepts a planning seat's calls once its build in planning is known", () => {
    const { db, builds } = seeded();
    const planning = buildChanged({ status: "planning", step: "planning" });
    const agent = buildAgent({ runId: null, buildId: BUILD, seat: "analyst", step: "planning" });
    expect(engineEventRefusal(db, endpoint, planning)).toBeNull();
    builds.ingest(planning);
    expect(engineEventRefusal(db, endpoint, agent)).toBeNull();
  });

  it("accepts a team chat message of a known build of the project", () => {
    const { db, builds } = seeded();
    const message = (buildId: string) =>
      ev({
        type: "message.sent",
        message: {
          version: 1,
          id: "M1",
          buildId,
          from: { kind: "seat", seat: "developer", taskId: "T1" },
          to: { kind: "seat", seat: "project-manager", taskId: null },
          routing: "by_type",
          type: "question",
          taskId: "T1",
          milestone: null,
          paths: [],
          body: "Which currency?",
          createdAt: T0,
        },
      });
    expect(engineEventRefusal(db, endpoint, message(BUILD))).toMatch(/unknown/);
    builds.ingest(buildChanged());
    expect(engineEventRefusal(db, endpoint, message(BUILD))).toBeNull();
    builds.upsert({ ...summary, id: OTHER_BUILD, projectId: OTHER_PROJECT });
    expect(engineEventRefusal(db, endpoint, message(OTHER_BUILD))).toMatch(OTHER_PROJECT);
  });

  it("checks both the run and the build of a review run that a build started", () => {
    const { db, builds } = seeded();
    builds.upsert(summary);
    expect(engineEventRefusal(db, endpoint, buildAgent({ runId: RUN, buildId: BUILD }))).toBeNull();
    expect(
      engineEventRefusal(db, endpoint, buildAgent({ runId: RUN, buildId: OTHER_BUILD })),
    ).toMatch(/unknown/);
  });

  it("refuses a call that names neither a run nor a build", () => {
    const { db } = seeded();
    expect(engineEventRefusal(db, endpoint, buildAgent({ runId: null }))).toMatch(
      /neither a run nor a build/,
    );
  });

  it("still accepts a review run's agent events without build fields", () => {
    const { db } = seeded();
    expect(engineEventRefusal(db, endpoint, buildAgent({ runId: RUN }))).toBeNull();
  });
});

describe("BuildMirror", () => {
  it("stores the newest state of each build and lists a project's builds", () => {
    const { builds } = seeded();
    builds.ingest(buildChanged());
    builds.ingest(buildChanged({ status: "finished", step: "review", updatedAt: T1 }));
    // An older state that arrives late doesn't replace a newer one.
    builds.ingest(buildChanged({ status: "paused", updatedAt: T0 }));
    expect(builds.get(BUILD)).toMatchObject({ status: "finished", step: "review" });
    expect(builds.list(PROJECT_ID).map((b) => b.id)).toEqual([BUILD]);
    expect(builds.list(OTHER_PROJECT)).toEqual([]);
    expect(builds.get(OTHER_BUILD)).toBeUndefined();
  });
});
