// The run directory: `<project>/.claude-box/runs/<run id>/`.
//
// Every stage hands its output to the next through a JSON file here, so a
// run resumes from any stage and every decision stays auditable:
//
//   state.json            RunState (the contract)
//   engine.json           the state machine's own bookkeeping
//   events.jsonl          every event the run emitted, one per line
//   findings.json         every finding of the run
//   preflight.json        the resolved range and the baseline gate
//   groups.json           the file groups of the latest round
//   rounds.json           RoundSummary for each finished round
//   rounds/<n>/<stage>.json   one file per stage output in round n
//   scratch/<finding id>/     disprover reproduction scripts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  FileGroupSchema,
  FindingSchema,
  RUNS_DIR,
  RoundSummarySchema,
  RunStateSchema,
  type AgentBoxEvent,
  type FileGroup,
  type Finding,
  type RoundSummary,
  type RunState,
  type Stage,
} from "@agentbox/contracts";
import { z } from "zod";
import { EngineStateSchema, newEngineState, type EngineState } from "./engine-state.js";
import { appendJsonLine, readJson, writeJsonAtomic } from "./files.js";

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} has no state.json file.`);
    this.name = "RunNotFoundError";
  }
}

/** Returns `<projectRoot>/.claude-box/runs`. */
export function runsDir(projectRoot: string): string {
  return join(projectRoot, RUNS_DIR);
}

/** Lists the run ids under a project, oldest first (run ids are ULIDs). */
export async function listRunIds(projectRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(runsDir(projectRoot), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export class RunStore {
  readonly dir: string;

  constructor(
    readonly projectRoot: string,
    readonly runId: string,
  ) {
    this.dir = join(runsDir(projectRoot), runId);
  }

  path(relative: string): string {
    return join(this.dir, relative);
  }

  /** The file for one stage's output in one round: `rounds/<n>/<stage>.json`. */
  roundFile(round: number, stage: Stage | string): string {
    return `rounds/${round}/${stage}.json`;
  }

  scratchDir(findingId: string): string {
    return this.path(join("scratch", findingId));
  }

  async writeJson(relative: string, value: unknown): Promise<void> {
    await writeJsonAtomic(this.path(relative), value);
  }

  async readJson<T>(
    relative: string,
    schema?: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T | undefined> {
    return readJson(this.path(relative), schema);
  }

  async saveState(state: RunState): Promise<void> {
    await this.writeJson("state.json", RunStateSchema.parse(state));
  }

  async loadState(): Promise<RunState> {
    const state = await this.readJson("state.json", RunStateSchema);
    if (!state) throw new RunNotFoundError(this.runId);
    return state;
  }

  async saveEngineState(state: EngineState): Promise<void> {
    await this.writeJson("engine.json", state);
  }

  async loadEngineState(): Promise<EngineState> {
    return (await this.readJson("engine.json", EngineStateSchema)) ?? newEngineState();
  }

  async saveFindings(findings: readonly Finding[]): Promise<void> {
    await this.writeJson("findings.json", z.array(FindingSchema).parse(findings));
  }

  async loadFindings(): Promise<Finding[]> {
    return (await this.readJson("findings.json", z.array(FindingSchema))) ?? [];
  }

  async saveGroups(groups: readonly FileGroup[], round?: number): Promise<void> {
    const parsed = z.array(FileGroupSchema).parse(groups);
    await this.writeJson("groups.json", parsed);
    if (round !== undefined) await this.writeJson(this.roundFile(round, "groups"), parsed);
  }

  async loadGroups(round?: number): Promise<FileGroup[] | undefined> {
    const file = round === undefined ? "groups.json" : this.roundFile(round, "groups");
    return this.readJson(file, z.array(FileGroupSchema));
  }

  async loadRounds(): Promise<RoundSummary[]> {
    return (await this.readJson("rounds.json", z.array(RoundSummarySchema))) ?? [];
  }

  async saveRoundSummary(summary: RoundSummary): Promise<void> {
    const parsed = RoundSummarySchema.parse(summary);
    const rounds = (await this.loadRounds()).filter((r) => r.round !== parsed.round);
    rounds.push(parsed);
    rounds.sort((a, b) => a.round - b.round);
    await this.writeJson("rounds.json", rounds);
    await this.writeJson(this.roundFile(parsed.round, "summary"), parsed);
  }

  async appendEvent(event: AgentBoxEvent): Promise<void> {
    await appendJsonLine(this.path("events.jsonl"), event);
  }

  /**
   * Every event in `events.jsonl`. A line that doesn't parse, such as an
   * append that a crash or a full disk cut short, is skipped, so it can't
   * hide the rest of the run's events. `onBadLine` hears how many it skipped.
   */
  async loadEvents(onBadLine?: (skipped: number) => void): Promise<AgentBoxEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path("events.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: AgentBoxEvent[] = [];
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as AgentBoxEvent);
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) onBadLine?.(skipped);
    return events;
  }
}
