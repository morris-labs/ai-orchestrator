// Build requests that the server forwards to the engine that runs a build:
// pause, resume, cancel, and delete from the owner, and a pause and resume
// that follow the build's box. A box stop pauses the box's running build
// after its current turn, and a box start resumes a build that the box's
// stop paused. A build that the owner paused stays paused.
import {
  BuildStateSchema,
  type AioEvent,
  type BuildPauseReason,
  type BuildState,
  type BuildSummary,
} from "@aio/contracts";
import type { ApiEngines } from "../api/deps.js";
import { ApiError } from "../api/errors.js";

export type BuildAction = "pause" | "resume" | "cancel" | "delete";

const ENGINE_ROUTES = {
  pause: "engine.builds.pause",
  resume: "engine.builds.resume",
  cancel: "engine.builds.cancel",
  delete: "engine.builds.delete",
} as const;

/** The `build.changed` summary of a build's state. */
export function buildSummaryOf(state: BuildState): BuildSummary {
  return {
    id: state.id,
    slug: state.slug,
    projectId: state.projectId,
    container: state.container,
    status: state.status,
    step: state.step,
    boxId: state.boxId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * Sends `action` for `build` to the engine that runs it and returns the
 * build's summary afterward. Throws `conflict` when that engine's container
 * isn't running.
 */
export async function controlBuild(
  engines: Pick<ApiEngines, "get">,
  build: BuildSummary,
  action: BuildAction,
  reason: BuildPauseReason = "owner",
): Promise<BuildSummary> {
  const engine = engines.get(build.container);
  if (!engine) {
    throw new ApiError(
      "conflict",
      `The container ${build.container} that runs build ${build.slug} is not running.`,
    );
  }
  engine.assertVersion();
  const takesReason = action === "pause" || action === "resume";
  const state = await engine.call(ENGINE_ROUTES[action], {
    params: { slug: build.slug },
    ...(takesReason ? { body: { reason } } : {}),
  });
  return buildSummaryOf(BuildStateSchema.parse(state));
}

export interface BoxBuildLinkDeps {
  /** The mirrored builds of every project. */
  builds: { list(): BuildSummary[] };
  engines: Pick<ApiEngines, "get">;
  log: (message: string) => void;
  /** How long to wait before asking again when the engine isn't up yet. Default: 5 seconds. */
  retryMs?: number;
  /** How many times to ask before giving up. Default: 24, two minutes at the default wait. */
  retries?: number;
}

/**
 * Pauses a box's running build when the box stops, and resumes the build
 * that its stop paused when the box starts. A box that starts with its
 * container, before the engine answers, is asked again until the engine
 * does.
 */
export class BoxBuildLink {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: BoxBuildLinkDeps) {}

  /** Follows `box.changed` events; ignores every other event. */
  ingest(event: AioEvent): void {
    if (event.type !== "box.changed") return;
    if (event.status === "stopped") this.follow(event.boxId, "pause", 0);
    if (event.status === "running") this.follow(event.boxId, "resume", 0);
  }

  /** Cancels the waits for engines that aren't up yet. */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private follow(boxId: string, action: "pause" | "resume", attempt: number): void {
    clearTimeout(this.timers.get(boxId));
    this.timers.delete(boxId);
    const want = action === "pause" ? "running" : "paused";
    const builds = this.deps.builds.list().filter((b) => b.boxId === boxId && b.status === want);
    let waiting = false;
    for (const build of builds) {
      if (!this.deps.engines.get(build.container)) {
        waiting = true;
        continue;
      }
      void controlBuild(this.deps.engines, build, action, "box").catch((err: unknown) => {
        // A build the owner paused refuses a box start's resume, and a
        // build that changed since the mirror saw it refuses either one.
        if ((err as ApiError).code === "invalid_state") return;
        this.deps.log(
          `Couldn't ${action} build ${build.slug} for box ${boxId}: ${(err as Error).message}`,
        );
      });
    }
    if (!waiting) return;
    if (attempt >= (this.deps.retries ?? 24)) {
      this.deps.log(`Gave up asking the engine to ${action} the build of box ${boxId}.`);
      return;
    }
    const timer = setTimeout(
      () => this.follow(boxId, action, attempt + 1),
      this.deps.retryMs ?? 5000,
    );
    timer.unref();
    this.timers.set(boxId, timer);
  }
}
