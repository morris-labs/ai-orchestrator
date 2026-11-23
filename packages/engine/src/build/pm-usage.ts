// The Project manager's usage, read from its transcripts. The Project
// manager is the main session of the build's box and makes no engine calls,
// so no lease settlement records what it spends. The engine reads the
// token counts from the Claude Code transcripts of the sessions that the
// `aio-build` command named, at each digest; see `pm-usage.ts` in contracts.
//
// Claude Code writes one line for each content block of a model response,
// each with the response's usage, and a resumed or forked session starts
// its transcript with a copy of the earlier turns. So the reader counts each
// response once, by its message ID, across every transcript it reads. A
// compaction adds a summary turn and continues; it repeats no response.
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  BUILD_PLANNING_FILE,
  BuildPlanningSchema,
  PM_SEAT,
  PM_SESSIONS_FILE,
  PmSessionSchema,
  type PmSession,
} from "@aio/contracts";
import { readJson, writeJsonAtomic } from "../run/files.js";
import type { BuildContext } from "./context.js";
import type { BuildStore } from "./store.js";

/** What a session spent: its model responses and their tokens. */
export interface TranscriptUsage {
  turns: number;
  /** Input tokens, cache reads and writes included, as engine calls count them. */
  tokensIn: number;
  tokensOut: number;
}

/** The turns to count: from `since`, and before `until` when it's set. */
export interface UsageWindow {
  since: string;
  until?: string;
}

interface Response {
  tokensIn: number;
  tokensOut: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The key and usage of a transcript line that records a model response, or `null`. */
function responseOf(line: string, from: number, to: number): [string, Response] | null {
  if (!line.includes('"usage"')) return null;
  let entry: Record<string, unknown> | null;
  try {
    entry = record(JSON.parse(line));
  } catch {
    return null;
  }
  if (entry?.type !== "assistant") return null;
  const message = record(entry.message);
  const usage = record(message?.usage);
  if (!message || !usage || message.model === "<synthetic>") return null;
  const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(time) || time < from || time >= to) return null;
  const key =
    (typeof message.id === "string" && message.id) ||
    (typeof entry.requestId === "string" && entry.requestId) ||
    (typeof entry.uuid === "string" && entry.uuid) ||
    null;
  if (!key) return null;
  return [
    key,
    {
      tokensIn:
        num(usage.input_tokens) +
        num(usage.cache_creation_input_tokens) +
        num(usage.cache_read_input_tokens),
      tokensOut: num(usage.output_tokens),
    },
  ];
}

/**
 * The usage that `files` record in `window`, each model response counted
 * once across every file. A missing file counts nothing.
 */
export async function transcriptUsage(
  files: readonly string[],
  window: UsageWindow,
): Promise<TranscriptUsage> {
  const from = Date.parse(window.since);
  const to = window.until === undefined ? Infinity : Date.parse(window.until);
  const responses = new Map<string, Response>();
  for (const file of new Set(files)) {
    const stream = createReadStream(file, { encoding: "utf8" });
    const opened = new Promise<boolean>((resolve) => {
      stream.once("open", () => resolve(true));
      stream.once("error", () => resolve(false));
    });
    if (!(await opened)) continue;
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      const found = responseOf(line, from, to);
      if (!found) continue;
      const [key, usage] = found;
      // Lines of one response can differ while it streams: keep the largest counts.
      const seen = responses.get(key);
      responses.set(
        key,
        seen
          ? {
              tokensIn: Math.max(seen.tokensIn, usage.tokensIn),
              tokensOut: Math.max(seen.tokensOut, usage.tokensOut),
            }
          : usage,
      );
    }
  }
  let tokensIn = 0;
  let tokensOut = 0;
  for (const r of responses.values()) {
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
  }
  return { turns: responses.size, tokensIn, tokensOut };
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * The transcripts of `session`: its `ID.jsonl` file in any working directory
 * folder under its transcripts folder, and its subagents' transcripts.
 */
export async function sessionTranscripts(
  session: Pick<PmSession, "id" | "transcripts">,
): Promise<string[]> {
  const files: string[] = [];
  for (const folder of await names(session.transcripts)) {
    const dir = join(session.transcripts, folder);
    const own = await names(dir);
    if (!own.includes(`${session.id}.jsonl`)) continue;
    files.push(join(dir, `${session.id}.jsonl`));
    const subagents = join(dir, session.id, "subagents");
    for (const name of await names(subagents)) {
      if (name.endsWith(".jsonl")) files.push(join(subagents, name));
    }
  }
  return files;
}

const SessionsFileSchema = z.object({ version: z.literal(1), sessions: z.array(PmSessionSchema) });

/** The Project manager's sessions of one build, in its `pm-sessions.json` file. */
export class PmSessionsFile {
  /** Serializes every read and write, so two requests never race. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  /** The sessions, in the order requests first named them. */
  async list(): Promise<PmSession[]> {
    return (await readJson(this.file, SessionsFileSchema))?.sessions ?? [];
  }

  /** Adds `session` unless the file holds it already. */
  note(session: Pick<PmSession, "id" | "transcripts">, now: string): Promise<void> {
    const run = this.chain.then(async () => {
      const sessions = await this.list();
      if (sessions.some((s) => s.id === session.id && s.transcripts === session.transcripts)) {
        return;
      }
      sessions.push(PmSessionSchema.parse({ ...session, seenAt: now }));
      await writeJsonAtomic(this.file, { version: 1, sessions });
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/** The sessions file of the build that `store` holds. */
export function pmSessionsOf(store: BuildStore): PmSessionsFile {
  return new PmSessionsFile(store.path(PM_SESSIONS_FILE));
}

/**
 * When the build's planning started: its planning record's creation, or the
 * build's own for a build that started from a plan the Project manager
 * wrote. Turns before it belong to other work and don't count.
 */
export async function planningStart(ctx: BuildContext): Promise<string> {
  const planning = await ctx.store
    .readJson(ctx.store.path(BUILD_PLANNING_FILE), BuildPlanningSchema)
    .catch(() => null);
  return planning?.createdAt ?? ctx.state.createdAt;
}

/** What the Project manager's sessions spent from `since` until `until`. */
export async function projectManagerUsage(
  ctx: BuildContext,
  window: UsageWindow,
): Promise<TranscriptUsage> {
  const files: string[] = [];
  for (const session of await pmSessionsOf(ctx.store).list()) {
    files.push(...(await sessionTranscripts(session)));
  }
  return transcriptUsage(files, window);
}

/**
 * Reads what the Project manager's sessions spent since planning started,
 * and sends it in a `build.seat.usage` event for the usage by seat. A read
 * that fails is logged and returns `null`; usage never stops a digest.
 */
export async function reportProjectManagerUsage(
  ctx: BuildContext,
): Promise<(TranscriptUsage & { since: string; through: string }) | null> {
  try {
    const since = await planningStart(ctx);
    const through = new Date(ctx.services.clock.now()).toISOString();
    const usage = await projectManagerUsage(ctx, { since });
    await ctx.emit({
      type: "build.seat.usage",
      buildId: ctx.state.id,
      seat: PM_SEAT,
      ...usage,
      since,
      through,
    });
    return { ...usage, since, through };
  } catch (error) {
    ctx.services.log.warn("Couldn't read the Project manager's usage", {
      build: ctx.state.slug,
      error: String(error),
    });
    return null;
  }
}
