// A box's own review run, which the box asks for through the secrets
// broker: the `aio-box-review` command in the image is the client. The
// broker passes the project its socket or token belongs to, so a box can
// start and read runs only in its own project, and this module limits it
// further to the box's own branch and the runs that box started.
import {
  RunRequestSchema,
  boxWorkDir,
  type BrokerReviewRunResponse,
  type BrokerReviewStartRequest,
  type Finding,
  type RunState,
} from "@aio/contracts";
import type { ApiDeps } from "./deps.js";
import { ApiError } from "./errors.js";
import { startRun, type RunStartDeps } from "./run-start.js";

/** What the broker's review routes call. */
export interface BoxReview {
  /** Starts a review run of the box's own branch in `projectId`. */
  start(projectId: string, request: BrokerReviewStartRequest): Promise<RunState>;
  /** The run `runId` that box `boxId` of `projectId` started, with its findings. */
  get(projectId: string, boxId: string, runId: string): Promise<BrokerReviewRunResponse>;
}

/**
 * Throws `not_found` unless box `boxId` is in `projectId`. A box of another
 * project gets the same answer as a box that doesn't exist, so a container
 * learns nothing about other projects.
 */
async function ownBox(deps: Pick<ApiDeps, "core">, projectId: string, boxId: string) {
  let view;
  try {
    view = await deps.core.boxes.get(boxId);
  } catch (err) {
    if ((err as ApiError).code !== "not_found") throw err;
  }
  if (!view || view.box.projectId !== projectId) {
    throw new ApiError("not_found", `This project has no box ${boxId}.`);
  }
  return view;
}

function runNotFound(runId: string, boxId: string): ApiError {
  return new ApiError("run_not_found", `Box ${boxId} started no run with the id ${runId}.`);
}

export function createBoxReview(deps: RunStartDeps): BoxReview {
  return {
    async start(projectId, request) {
      const view = await ownBox(deps, projectId, request.boxId);
      const { box } = view;
      if (request.branch !== undefined && request.branch !== box.branch) {
        throw new ApiError(
          "validation",
          box.branch === undefined
            ? `Box ${box.id} has no branch of its own, so it can review only its checked-out branch. Leave out the branch.`
            : `Box ${box.id} can review only its own branch, ${box.branch}, not ${request.branch}.`,
        );
      }
      const body = RunRequestSchema.parse({
        projectId,
        boxId: box.id,
        repoPath: view.containerWorkDir ?? boxWorkDir(box),
        ...(box.branch !== undefined ? { tip: box.branch } : {}),
        ...(request.base !== undefined ? { base: request.base } : {}),
        ...(request.readOnly !== undefined ? { readOnly: request.readOnly } : {}),
        ...(request.profile !== undefined ? { profile: request.profile } : {}),
        ...(request.depth !== undefined ? { depth: request.depth } : {}),
      });
      return startRun(deps, body);
    },

    async get(projectId, boxId, runId) {
      await ownBox(deps, projectId, boxId);
      const engine = deps.engines.forProject(projectId);
      let run: RunState | undefined;
      let findings: Finding[];
      if (engine) {
        engine.assertVersion();
        try {
          run = (await engine.call("engine.runs.get", { params: { runId } })) as RunState;
        } catch (err) {
          if ((err as ApiError).code === "run_not_found") throw runNotFound(runId, boxId);
          throw err;
        }
        if (deps.runs.foreignReason(engine.endpoint, run) !== null) {
          throw runNotFound(runId, boxId);
        }
        deps.runs.upsert(run);
      } else {
        // A stopped container's run stays readable from the mirror.
        run = deps.runs.get(runId);
      }
      if (!run || run.projectId !== projectId || run.boxId !== boxId) {
        throw runNotFound(runId, boxId);
      }
      if (engine) {
        const listed = (await engine.call("engine.findings.list", { params: { runId } })) as {
          findings: Finding[];
        };
        findings = listed.findings;
      } else {
        findings = deps.runs.findings?.(runId) ?? [];
      }
      return { run, findings };
    },
  };
}
