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
import type { PmSession } from "@aio/contracts";

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
