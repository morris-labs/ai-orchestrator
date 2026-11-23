// A build's files in `PROJECT_ROOT/.aio/builds/SLUG/`. Every handoff is a
// file, and each step saves its result before the next one starts, so a
// restarted engine continues a build from its last finished step.
//
// Layout:
//
//   plan.json                    the build plan, as the build started with it
//   state.json                   the build's state (`BuildState`)
//   engine.json                  the agent-call ledger: lease and agent counters, vendor limits
//   STATUS.md                    the status file that the Project manager rereads
//   events.jsonl                 every event the build sent
//   calls/KEY.json               each finished agent call, so a resume never repeats one
//   tasks/TASK/attempt-N.json    each attempt: its start, its agent call, and its gate result
//   escalations/ID.json          each escalation, with its details
//   scratch/                     scratch space for agents
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILDS_DIR,
  BuildPlanSchema,
  BuildSlugSchema,
  BuildStateSchema,
  type BuildPlan,
  type BuildState,
} from "@aio/contracts";
import { z } from "zod";
import type { AioEvent } from "@aio/contracts";
import { newCallLedger, type CallLedger } from "../calls/index.js";
import { appendJsonLine, readJson, writeFileAtomic, writeJsonAtomic } from "../run/files.js";

/** Thrown for a build that has no files. */
export class BuildNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`No build ${slug}.`);
    this.name = "BuildNotFoundError";
  }
}

const LedgerSchema = z.object({
  counters: z.object({ lease: z.number().int(), agent: z.number().int() }),
  limitedVendors: z.record(z.object({ until: z.string().nullable(), message: z.string() })),
});

const EngineFileSchema = z.object({ ledger: LedgerSchema });

/** The directory that holds every build of a project. */
export function buildsDir(projectRoot: string): string {
  return join(projectRoot, BUILDS_DIR);
}

/** The slugs of every build directory in the project, sorted. */
export async function listBuildSlugs(projectRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(buildsDir(projectRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((e) => e.isDirectory() && BuildSlugSchema.safeParse(e.name).success)
    .map((e) => e.name)
    .sort();
}

/** A key that is safe as a file name. */
function fileKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class BuildStore {
  readonly dir: string;

  constructor(
    readonly projectRoot: string,
    readonly slug: string,
  ) {
    this.dir = join(buildsDir(projectRoot), slug);
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  get scratchDir(): string {
    return this.path("scratch");
  }

  async loadState(): Promise<BuildState> {
    const state = await readJson(this.path("state.json"), BuildStateSchema);
    if (!state) throw new BuildNotFoundError(this.slug);
    return state;
  }

  async loadPlan(): Promise<BuildPlan> {
    const plan = await readJson(this.path("plan.json"), BuildPlanSchema);
    if (!plan) throw new BuildNotFoundError(this.slug);
    return plan;
  }

  async loadLedger(): Promise<CallLedger> {
    const saved = await readJson(this.path("engine.json"), EngineFileSchema);
    return saved ? (saved.ledger as CallLedger) : newCallLedger();
  }

  savePlan(plan: BuildPlan): Promise<void> {
    return writeJsonAtomic(this.path("plan.json"), plan);
  }

  /** Saves the state, the ledger, and the status file. */
  async save(state: BuildState, ledger: CallLedger, status: string): Promise<void> {
    await writeJsonAtomic(this.path("engine.json"), { ledger });
    await writeJsonAtomic(this.path("state.json"), state);
    await writeFileAtomic(this.path("STATUS.md"), status);
  }

  appendEvent(event: AioEvent): Promise<void> {
    return appendJsonLine(this.path("events.jsonl"), event);
  }

  callPath(key: string): string {
    return this.path("calls", `${fileKey(key)}.json`);
  }

  attemptPath(taskId: string, attempt: number): string {
    return this.path("tasks", fileKey(taskId), `attempt-${attempt}.json`);
  }

  /** The Debugger's diagnosis of the failure that repeated in attempts `attempt - 1` and `attempt`. */
  diagnosisPath(taskId: string, attempt: number): string {
    return this.path("tasks", fileKey(taskId), `diagnosis-${attempt}.json`);
  }

  escalationPath(id: string): string {
    return this.path("escalations", `${fileKey(id)}.json`);
  }

  readJson<T>(path: string, schema?: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T | undefined> {
    return readJson(path, schema);
  }

  writeJson(path: string, value: unknown): Promise<void> {
    return writeJsonAtomic(path, value);
  }

  writeText(path: string, text: string): Promise<void> {
    return writeFileAtomic(path, text);
  }
}
