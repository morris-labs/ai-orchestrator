// Starting a review run: the server's `runs.create` route and a box's
// review request through the secrets broker both start runs here, so both
// get the same checks, the same mirror record, and the same hold-edits
// message to the box.
import {
  READ_ONLY_POST_PUSH_MESSAGE,
  isReadOnlyPostPush,
  type RunRequest,
  type RunState,
} from "@aio/contracts";
import path from "node:path";
import type { ApiDeps } from "./deps.js";
import { ApiError } from "./errors.js";
import { ulid } from "./ulid.js";

/** The message a box's interactive session receives when a run starts on its tree. */
export const HOLD_EDITS_MESSAGE =
  "A review run has started on this branch. Hold all edits to the working tree until the run finishes; you will get a message when it does.";

/** The message a box's interactive session receives when that run ends. */
export const RELEASE_EDITS_MESSAGE =
  "The review run on this branch has ended. You can edit the working tree again.";

/** What starting a run needs from the API's services. */
export type RunStartDeps = Pick<ApiDeps, "core" | "engines" | "runs" | "sessionMessages" | "log">;

/**
 * Refuses a relative path. The server's working directory means nothing to
 * the caller, so a client resolves a path against its own before sending it.
 * A `container` path is a POSIX path whatever the host is.
 */
export function requireAbsolute(
  value: string | null | undefined,
  field: string,
  side: "host" | "container" = "host",
): void {
  if (value === null || value === undefined) return;
  const absolute = side === "host" ? path.isAbsolute(value) : path.posix.isAbsolute(value);
  if (!absolute) throw new ApiError("validation", `${field} must be an absolute path: ${value}.`);
}

/**
 * Refuses a run whose box is in another project: the run would hold that
 * box, and the hold-edits message would go to it.
 */
export async function requireBoxInProject(
  core: ApiDeps["core"],
  boxId: string | undefined,
  projectId: string,
): Promise<void> {
  if (boxId === undefined) return;
  const { box } = await core.boxes.get(boxId);
  if (box.projectId !== projectId) {
    throw new ApiError(
      "validation",
      `Box ${boxId} belongs to project ${box.projectId}, not ${projectId}.`,
    );
  }
}

/** Prepares the Codex and Copilot default accounts that a run's calls sign in with. */
export async function prepareReviewAccounts(deps: Pick<ApiDeps, "core" | "log">): Promise<void> {
  const defaults = (await deps.core.settings.get()).accountDefaults;
  for (const vendor of ["codex", "copilot"] as const) {
    if (!defaults[vendor]) continue;
    const { problems } = await deps.core.accounts.prepare({ vendor });
    for (const problem of problems) deps.log?.(`${vendor}: ${problem}`);
  }
}

/**
 * Starts a run on the engine of the request's project, records it in the
 * mirror, and tells the run's box to hold its edits.
 */
export async function startRun(deps: RunStartDeps, body: RunRequest): Promise<RunState> {
  // The request schema refuses this too; the check here keeps the refusal if the schema changes.
  if (isReadOnlyPostPush(body)) throw new ApiError("validation", READ_ONLY_POST_PUSH_MESSAGE);
  requireAbsolute(body.repoPath, "The repository path", "container");
  await requireBoxInProject(deps.core, body.boxId, body.projectId);
  await prepareReviewAccounts(deps);
  const engine = deps.engines.requireProject(body.projectId);
  // An older engine drops request fields it doesn't know, such as
  // `concurrency`, so the server forwards a run only to an engine whose
  // version it has confirmed.
  await engine.confirmVersion();
  const run = (await engine.call("engine.runs.create", {
    body: { ...body, runId: ulid() },
  })) as RunState;
  deps.runs.upsert(run);
  if (body.boxId !== undefined) deps.sessionMessages.send(body.boxId, HOLD_EDITS_MESSAGE);
  return run;
}
