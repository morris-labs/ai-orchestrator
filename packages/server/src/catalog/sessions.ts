// Helpers that read what a running Claude Code process reports about itself:
// its per-process `<pid>.json` session files and the tail of its transcript
// (port of `SessionWatcher::readEntries` and the session-sync parts of
// `DockerBackend.cpp`).
import fs from "node:fs/promises";
import path from "node:path";
import { GUARDED_READ_FLAGS, readRegularFile } from "../records/regular-file.js";

/** One `<pid>.json` file from a Claude Code sessions directory. */
export interface SessionEntry {
  /** The file the entry came from. */
  file: string;
  pid: number;
  pidDomain: string;
  procStart: string;
  sessionId: string;
  name: string;
  entrypoint: string;
  updatedAt: number;
  /** `nameSource == "user"`; an absent source means an auto-generated name. */
  nameIsUser: boolean;
}

/** The key that identifies one process across rewrites: `pid|pidDomain|procStart`. */
export function sessionEntryKey(e: Pick<SessionEntry, "pid" | "pidDomain" | "procStart">): string {
  return `${e.pid}|${e.pidDomain}|${e.procStart}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Reads every `*.json` in a sessions directory. Files that do not parse (a
 * half-written rewrite), entries without a pid or a session id, and
 * anything other than a regular file are skipped: the container writes this
 * directory, and a FIFO there would block the read until a writer appears.
 * A missing directory gives `[]`.
 */
export async function readSessionEntries(dir: string): Promise<SessionEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SessionEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let obj: Record<string, unknown>;
    const content = await readRegularFile(file);
    if (content === null) continue;
    try {
      const v: unknown = JSON.parse(content);
      if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
      obj = v as Record<string, unknown>;
    } catch {
      continue;
    }
    const entry: SessionEntry = {
      file,
      pid: Math.trunc(num(obj.pid)),
      pidDomain: str(obj.pidDomain),
      procStart: str(obj.procStart),
      sessionId: str(obj.sessionId),
      name: str(obj.name),
      entrypoint: str(obj.entrypoint),
      updatedAt: Math.trunc(num(obj.updatedAt)),
      nameIsUser: obj.nameSource === "user",
    };
    if (entry.pid > 0 && entry.sessionId !== "") out.push(entry);
  }
  return out;
}

/**
 * The session id and the user-chosen name of the newest entry. With a
 * `sessionUuid` (a box in a shared directory), only entries for that session
 * count. `name` is `""` when the newest entry's name was not set by the user.
 */
export function liveSessionName(
  entries: readonly SessionEntry[],
  sessionUuid: string | null,
): { sessionId: string; name: string } | undefined {
  let best: SessionEntry | undefined;
  for (const e of entries) {
    if (sessionUuid !== null && e.sessionId !== sessionUuid) continue;
    if (!best || e.updatedAt >= best.updatedAt) best = e;
  }
  return best ? { sessionId: best.sessionId, name: best.nameIsUser ? best.name : "" } : undefined;
}

const TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The model and effort of the last real assistant entry in a transcript.
 * Reads only the last 4 MiB. Synthetic replies (`<synthetic>`) are skipped.
 */
export async function liveModelAndEffort(
  transcriptFile: string,
): Promise<{ model?: string; effort?: string }> {
  let handle;
  try {
    // The container writes transcripts too: refuse a FIFO or a link.
    handle = await fs.open(transcriptFile, GUARDED_READ_FLAGS);
  } catch {
    return {};
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return {};
    const { size } = st;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i] as string;
      if (!line.includes('"type":"assistant"')) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a partial first line
      }
      if (obj === null || typeof obj !== "object" || obj.type !== "assistant") continue;
      let model = str(obj.requestedModel);
      if (model === "") {
        const message = obj.message;
        if (message !== null && typeof message === "object")
          model = str((message as Record<string, unknown>).model);
      }
      if (model === "" || model.startsWith("<")) continue;
      const effort = str(obj.effort);
      return effort === "" ? { model } : { model, effort };
    }
    return {};
  } finally {
    await handle.close();
  }
}

/**
 * Whether a recorded model and a live model id name the same model. An alias
 * such as `opus` or `opus[1m]` matches any id that contains it; a full
 * `claude-` id must match exactly (ignoring a `[...]` suffix).
 */
export function sameModel(recorded: string, live: string): boolean {
  const bracket = recorded.indexOf("[");
  const r = bracket >= 0 ? recorded.slice(0, bracket) : recorded;
  if (r === "" || r === live) return true;
  return !r.startsWith("claude-") && live.toLowerCase().includes(r.toLowerCase());
}
