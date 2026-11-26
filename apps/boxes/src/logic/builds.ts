// The app's view of builds: labels for a build's state and step, the list
// that `build.changed` events keep current, and which box runs which build.
import type { BuildStatus, BuildStep, BuildSummary } from "@aio/contracts";

export const buildStatusLabel: Record<BuildStatus, string> = {
  planning: "Planning",
  running: "Running",
  paused: "Paused",
  waiting_escalation: "Waiting for you",
  finished: "Finished",
  failed: "Failed",
  cancelled: "Canceled",
};

export const buildStepLabel: Record<BuildStep, string> = {
  planning: "Planning",
  preflight: "Preflight",
  contracts: "Contracts",
  tests_first: "Tests first",
  tasks: "Tasks",
  integrate: "Integrate",
  harden: "Harden",
  simplify: "Simplify",
  review: "Review",
  release_ready: "Release ready",
};

/** A build's state as the app shows it; a build that finished its release-ready step is release ready. */
export function buildStateLabel(build: BuildSummary): string {
  if (build.status === "finished" && build.step === "release_ready") return "Release ready";
  return buildStatusLabel[build.status];
}

export function stepLabel(step: BuildStep | null): string {
  return step === null ? "Not started" : buildStepLabel[step];
}

/** The statuses of a build that still holds its box: it runs, waits, or can resume. */
const ACTIVE: ReadonlySet<BuildStatus> = new Set([
  "planning",
  "running",
  "paused",
  "waiting_escalation",
]);

export function isBuildActive(build: BuildSummary): boolean {
  return ACTIVE.has(build.status);
}

/** Newest first, as the server lists builds. */
export function sortBuilds(builds: readonly BuildSummary[]): BuildSummary[] {
  return [...builds].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id),
  );
}

/**
 * Applies a `build.changed` state. A state older than the one the list
 * holds changes nothing, as on the server.
 */
export function applyBuildChanged(
  builds: readonly BuildSummary[],
  build: BuildSummary,
): BuildSummary[] {
  const current = builds.find((b) => b.id === build.id);
  if (current && Date.parse(current.updatedAt) > Date.parse(build.updatedAt)) return [...builds];
  return sortBuilds([...builds.filter((b) => b.id !== build.id), build]);
}

/** The newest active build of each box, by box id. */
export function activeBuildsByBox(
  builds: readonly BuildSummary[],
): ReadonlyMap<string, BuildSummary> {
  const byBox = new Map<string, BuildSummary>();
  for (const b of sortBuilds(builds)) {
    if (b.boxId !== null && isBuildActive(b) && !byBox.has(b.boxId)) byBox.set(b.boxId, b);
  }
  return byBox;
}
