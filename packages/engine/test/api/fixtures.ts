// Sample documents and fakes shared by the engine service tests.
import {
  BuildPlanSchema,
  EngineRunCreateSchema,
  type BuildFreezeAnswer,
  type BuildMeetingAnswer,
  type BuildPlanning,
  type BuildSeatAnswer,
  type BuildState,
  type FileGroup,
  type Finding,
  type RoundSummary,
  type RunState,
} from "@aio/contracts";
import { vi } from "vitest";
import type { FindingDetail, RunManager } from "../../src/api/core-interface.js";
import type { BuildManager } from "../../src/build/manager.js";
import { EngineLeaseBroker } from "../../src/events/leases.js";
import { EventHub } from "../../src/events/hub.js";
import { silentLogger } from "../../src/main/logger.js";

export const TOKEN = "test-token-0123456789abcdef";
export const T0 = "2026-10-28T09:00:00.000Z";
export const T1 = "2026-10-28T09:05:00.000Z";
export const RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2P";
export const CONTAINER = "aio-agent-proj-example-1a2b3c4d";
export const PROJECT_ROOT = "/home/user/src/example";

export const runCreate = EngineRunCreateSchema.parse({
  runId: RUN,
  projectId: "example-1a2b3c4d",
  repoPath: PROJECT_ROOT,
  tip: "claude/feature",
});

export const runState: RunState = {
  id: RUN,
  projectId: "example-1a2b3c4d",
  container: CONTAINER,
  request: (({ runId: _r, ...rest }) => rest)(runCreate),
  status: "running",
  stage: "find",
  round: 1,
  profile: "offload",
  roles: { reviewer: ["codex"], disprover: "copilot", confirmer: "codex", fixer: "claude" },
  stopReason: null,
  decision: null,
  createdAt: T0,
  updatedAt: T1,
};

export const fileGroup: FileGroup = {
  id: "G-01",
  files: ["src/a.ts"],
  kind: "major",
  changedLines: 10,
  riskPath: false,
  hunks: [{ id: "H-1", file: "src/a.ts", start: 1, end: 5 }],
};

export const finding: Finding = {
  id: "F-0001",
  fingerprint: "3f786850e387550fdab836ed7e6dc881de23001b",
  severity: "P1",
  title: "Retry loop never gives up",
  file: "src/a.ts",
  lines: [1, 5],
  failureCase: "A closed socket retries forever.",
  category: "correctness",
  introduced: true,
  reportedBy: "codex-gpt-5",
  alsoReportedBy: [],
  verdict: "pending",
  verification: null,
  evidence: "",
  runId: RUN,
  round: 1,
  groupId: "G-01",
  hunkIds: ["H-1"],
  origin: "reviewer",
  history: [],
} as unknown as Finding;

export const roundSummary: RoundSummary = {
  runId: RUN,
  round: 1,
  perVendor: {},
  fixed: 0,
  overlapRate: 0,
  costUsd: 0,
  startedAt: T0,
  finishedAt: T1,
};

export const usageSample = {
  vendor: "claude" as const,
  account: "user@example.com",
  window: "5h" as const,
  utilization: 0.3,
  spendUsd: null,
  ceiling: { kind: "utilization" as const, window: "5h" as const, max: 0.6 },
  resetAt: T1,
  sampleSource: "rate_limit_event" as const,
  time: T0,
};

/** A run manager whose every method is a `vi.fn` returning sample data. */
export function fakeRunManager(): {
  [K in keyof RunManager]-?: ReturnType<typeof vi.fn>;
} & RunManager {
  const detail: FindingDetail = { finding, diff: "@@ -1 +1 @@", fixDiff: null };
  const m = {
    list: vi.fn(async () => [runState]),
    preview: vi.fn(async () => ({
      baseSha: "0123456789abcdef",
      tipSha: "89abcdef",
      diffBaseSha: "0123456789abcdef",
      groups: [fileGroup],
      changedLines: 10,
      dirty: false,
    })),
    start: vi.fn(async () => runState),
    get: vi.fn(async (id: string) => (id === RUN ? runState : null)),
    pause: vi.fn(async () => ({ ...runState, status: "paused" })),
    resume: vi.fn(async () => runState),
    cancel: vi.fn(async () => ({ ...runState, status: "cancelled" })),
    profile: vi.fn(async () => ({ ...runState, profile: "fast" })),
    assign: vi.fn(async () => runState),
    rebaseBase: vi.fn(async () => runState),
    retry: vi.fn(async () => runState),
    decide: vi.fn(async () => runState),
    push: vi.fn(async () => runState),
    groups: vi.fn(async () => [fileGroup]),
    rounds: vi.fn(async () => [roundSummary]),
    findings: vi.fn(async () => [finding]),
    finding: vi.fn(async (_r: string, id: string) => (id === finding.id ? detail : null)),
    waive: vi.fn(async () => ({ ...finding, verdict: "waived" })),
    usageSamples: vi.fn(async () => [usageSample]),
    activeRunCount: vi.fn(() => 1),
    close: vi.fn(async () => {}),
  };
  return m as never;
}

export const buildState: BuildState = {
  version: 1,
  id: RUN,
  slug: "cart-total",
  projectId: "proj-1",
  boxId: null,
  container: CONTAINER,
  title: "Add a total to the cart",
  repoPath: PROJECT_ROOT,
  base: "0123456789abcdef0123456789abcdef01234567",
  branch: "build/cart-total",
  worktree: `${PROJECT_ROOT}/.worktrees/build-cart-total`,
  status: "running",
  step: "tasks",
  tasks: [{ id: "T1", status: "running", attempts: 1, commit: null }],
  escalations: [],
  placements: { singleVendor: null, plan: {}, live: [] },
  createdAt: "2026-11-23T09:00:00.000Z",
  updatedAt: "2026-11-23T09:00:00.000Z",
};

/** A build's planning record, with one Analyst call and no frozen plan. */
export const planningRecord: BuildPlanning = {
  version: 1,
  id: RUN,
  slug: "cart-total",
  projectId: "proj-1",
  boxId: null,
  container: CONTAINER,
  repoPath: PROJECT_ROOT,
  issue: null,
  calls: [
    {
      key: "plan-analyst-1",
      seat: "analyst",
      n: 1,
      status: "done",
      file: "planning/analyst-1.json",
      startedAt: "2026-11-23T09:00:00.000Z",
      finishedAt: "2026-11-23T09:05:00.000Z",
    },
  ],
  frozen: [],
  meetings: [],
  createdAt: "2026-11-23T09:00:00.000Z",
  updatedAt: "2026-11-23T09:05:00.000Z",
};

/** The answer to a seat call. */
export const seatAnswer: BuildSeatAnswer = {
  planning: planningRecord,
  call: planningRecord.calls[0] as BuildSeatAnswer["call"],
  answer: { title: "Add a total to the cart", size: "small" },
};

/** The answer to a freeze. */
export const freezeAnswer: BuildFreezeAnswer = {
  planning: {
    ...planningRecord,
    frozen: [
      {
        version: 1,
        file: "plans/v1.json",
        hash: "a".repeat(64),
        push: true,
        frozenAt: "2026-11-23T09:10:00.000Z",
      },
    ],
  },
  frozen: {
    version: 1,
    file: "plans/v1.json",
    hash: "a".repeat(64),
    push: true,
    frozenAt: "2026-11-23T09:10:00.000Z",
  },
  plan: BuildPlanSchema.parse({
    title: "Add a total to the cart",
    criteria: [{ id: "AC1", text: "The cart reports the sum of its item prices." }],
    tasks: [
      {
        id: "T1",
        title: "Cart total",
        description: "Sum the prices.",
        ownedFiles: ["src/cart.mjs"],
        criteria: ["AC1"],
      },
    ],
    commands: { test: [{ command: "node test/cart.test.mjs" }] },
    push: true,
  }),
};

/** A build manager whose every method is a `vi.fn` returning sample data. */
/** The answer to a meeting that ended with a major objection open. */
export const meetingAnswer: BuildMeetingAnswer = {
  planning: {
    ...planningRecord,
    meetings: [{ id: "meeting-1", file: "meetings/meeting-1.json", status: "round_cap" }],
  },
  meeting: {
    version: 1,
    id: "meeting-1",
    proposer: "architect",
    members: ["critic"],
    brief: "Attack the design.",
    roundCap: 1,
    status: "round_cap",
    rounds: [
      {
        n: 1,
        proposal: "planning/architect-1.json",
        turns: [
          {
            seat: "critic",
            status: "done",
            files: ["planning/critic-1.json"],
            reply: {
              position: "object",
              summary: "The design misses the empty cart.",
              points: [
                { severity: "major", point: "No task covers an empty cart.", reason: "AC1." },
              ],
            },
            posts: [],
          },
        ],
      },
    ],
    posts: [],
    open: [
      { seat: "critic", severity: "major", point: "No task covers an empty cart.", reason: "AC1." },
    ],
    startedAt: "2026-11-23T09:06:00.000Z",
    finishedAt: "2026-11-23T09:08:00.000Z",
  },
};

export function fakeBuildManager(): {
  [K in keyof BuildManager]-?: ReturnType<typeof vi.fn>;
} & BuildManager {
  const m = {
    plan: vi.fn(async () => seatAnswer),
    freeze: vi.fn(async () => freezeAnswer),
    meet: vi.fn(async () => meetingAnswer),
    meetingPost: vi.fn(async () => meetingAnswer),
    start: vi.fn(async () => buildState),
    get: vi.fn(async (slug: string) => (slug === buildState.slug ? buildState : null)),
    pause: vi.fn(async () => ({ ...buildState, status: "paused" })),
    resume: vi.fn(async () => buildState),
    cancel: vi.fn(async () => ({ ...buildState, status: "cancelled" })),
    delete: vi.fn(async () => ({
      ...buildState,
      status: "cancelled",
      deletedAt: buildState.updatedAt,
    })),
    activeCount: vi.fn(() => 0),
    close: vi.fn(async () => {}),
  };
  return m as never;
}

export function newHub(): EventHub {
  return new EventHub({ source: `engine:${CONTAINER}`, streamId: "stream-1" });
}

export function newBroker(hub: EventHub, now?: () => Date): EngineLeaseBroker {
  return new EngineLeaseBroker({ log: silentLogger, now, tickMs: 60_000 });
}

/** Builds the engine app on a fake core and listens on a free loopback port. */
export async function listenEngine(overrides: { hub?: EventHub; leases?: EngineLeaseBroker } = {}) {
  const { buildEngineApp } = await import("../../src/api/server.js");
  const hub = overrides.hub ?? newHub();
  const leases = overrides.leases ?? newBroker(hub);
  const app = await buildEngineApp({
    token: TOKEN,
    container: CONTAINER,
    projectRoot: PROJECT_ROOT,
    engineVersion: "1.0.0-dev",
    expectedVersion: "1.0.0-dev",
    hub,
    leases,
    log: silentLogger,
    runs: fakeRunManager(),
    builds: fakeBuildManager(),
    repos: { list: async () => [], refs: async () => ({}) as never },
    ports: { list: () => [] },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { app, hub, leases, port, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}
