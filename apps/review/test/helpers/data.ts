// Sample server documents for the screen tests, built from the demo stream so
// the two stay consistent.
import type { Finding, ProjectSummary, RoundSummary, RunState } from "@aio/contracts";
import { defaultConfig } from "@aio/contracts";
import {
  DEMO_BOX as BOX,
  DEMO_CONTAINER as CONTAINER,
  DEMO_PROJECT as PROJECT,
  DEMO_RUN_ID as RUN_ID,
  buildDemoEvents,
} from "@aio/ui/testing";

export { BOX, CONTAINER, PROJECT, RUN_ID };

/** The scripted demo stream from `@aio/ui/testing`. */
export const loadDemoEvents = buildDemoEvents;

const events = buildDemoEvents();

export function lastRun(): RunState {
  const runs = events.filter((e) => e.type === "run.changed");
  return runs[runs.length - 1]!.run;
}

export function demoFindings(): Finding[] {
  const map = new Map<string, Finding>();
  for (const e of events) if (e.type === "finding.changed") map.set(e.finding.id, e.finding);
  return [...map.values()];
}

export function demoRounds(): RoundSummary[] {
  return events.flatMap((e) =>
    e.type === "run.changed" && e.roundSummary ? [e.roundSummary] : [],
  );
}

export function demoBox() {
  const e = events.find((x) => x.type === "box.changed");
  if (!e || e.type !== "box.changed" || !e.box) throw new Error("The demo has no box.");
  return e.box;
}

export const project: ProjectSummary = {
  project: {
    id: PROJECT,
    root: "/home/user/src/example-app",
    name: "example-app",
    primaryRepo: "/home/user/src/example-app",
    tcpMaps: [],
    mounts: [],
    secretRefs: [],
    policyPath: ".aio/policy.yaml",
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
  },
  running: 1,
  total: 1,
  container: {
    name: CONTAINER,
    state: "running",
    engine: { hostPort: 20412, version: "1.0.0-dev", healthy: true, versionMatches: true },
  },
};

export const settings = defaultConfig();

export function boxView() {
  return {
    box: demoBox(),
    status: "running" as const,
    container: CONTAINER,
    tmuxSession: BOX,
    reviewState: { state: "idle" as const },
    stats: null,
    listeners: [],
    proxyUrls: [],
    sideSessions: [],
    targetDirExists: true,
  };
}
