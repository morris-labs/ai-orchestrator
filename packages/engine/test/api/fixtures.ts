// Sample documents and fakes shared by the engine service tests.
import {
  EngineRunCreateSchema,
  type FileGroup,
  type Finding,
  type RoundSummary,
  type RunState,
} from "@aio/contracts";
import { vi } from "vitest";
import type { FindingDetail, RunManager } from "../../src/api/core-interface.js";
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
    repos: { list: async () => [], refs: async () => ({}) as never },
    ports: { list: () => [] },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { app, hub, leases, port, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}
