// Reads Claude Code's transcript store, `~/.claude/projects/<encoded>/<uuid>.jsonl`,
// so a box can adopt a conversation the server did not create (port of
// `ConversationCatalog.cpp`).
//
// Transcripts are newline-delimited JSON and run to tens of MB. Each line is
// matched for a byte marker first and parsed only when it matches.
import fs from "node:fs/promises";
import path from "node:path";
import type { ConversationSummary } from "@agentbox/contracts";
import type { HostEnv } from "../records/env.js";
import { projectDirFor, transcriptPath } from "./paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const M_CUSTOM = Buffer.from('"custom-title"');
const M_AI = Buffer.from('"ai-title"');
const M_LAST = Buffer.from('"last-prompt"');
const M_USER_TYPE = Buffer.from('"type":"user"');
const M_USER_ROLE = Buffer.from('"message":{"role":"user"');
const M_SIDECHAIN = Buffer.from('"isSidechain":true');
const M_META = Buffer.from('"isMeta":true');
const M_TOOL_RESULT = Buffer.from('"tool_result"');

/** Calls `fn` with each newline-terminated line of `buf`, without copying. */
function forEachLine(buf: Buffer, fn: (line: Buffer) => void): void {
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    fn(buf.subarray(start, end));
    start = end + 1;
  }
}

function parseLine(line: Buffer): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(line.toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The text a user typed in a user entry, or `""` for subagent, meta, or tool traffic. */
function textOfUserMessage(obj: Record<string, unknown>): string {
  if (obj.isSidechain === true || obj.isMeta === true) return "";
  const message = obj.message;
  if (message === null || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part !== null && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (p.type === "text") return str(p.text);
      }
    }
  }
  return "";
}

/** Slash commands and local command output start with `<` and make no title. */
function isUsableAsTitle(text: string): boolean {
  return text !== "" && !text.startsWith("<");
}

/** For a prompt from the old issue workflow, the issue name only. */
export function openingPromptTitle(prompt: string): string {
  if (prompt.startsWith("Issue: ")) {
    const cut = prompt.indexOf(". Your workspace folder ");
    if (cut > 0) return prompt.slice(7, cut);
  }
  return prompt;
}

/**
 * Joins lines, collapses whitespace runs, trims, and cuts to `maxChars`
 * UTF-16 units with a trailing ellipsis (as `QString::simplified` did).
 */
export function condense(text: string, maxChars: number): string {
  let out = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trim()}…`;
  return out;
}

interface Scan {
  customTitle: string;
  aiTitle: string;
  openingPrompt: string;
  lastPrompt: string;
  userTurns: number;
}

function scanTranscript(buf: Buffer): Scan {
  const s: Scan = { customTitle: "", aiTitle: "", openingPrompt: "", lastPrompt: "", userTurns: 0 };
  let openingAttempts = 0;
  forEachLine(buf, (line) => {
    // Title records are appended again as a conversation moves on, so the
    // last one of each kind wins.
    if (line.includes(M_CUSTOM)) {
      const obj = parseLine(line);
      if (obj.type === "custom-title") s.customTitle = str(obj.customTitle);
      return;
    }
    if (line.includes(M_AI)) {
      const obj = parseLine(line);
      if (obj.type === "ai-title") s.aiTitle = str(obj.aiTitle);
      return;
    }
    if (line.includes(M_LAST)) {
      const obj = parseLine(line);
      if (obj.type === "last-prompt") s.lastPrompt = str(obj.lastPrompt);
      return;
    }
    if (!line.includes(M_USER_TYPE) || !line.includes(M_USER_ROLE)) return;
    if (line.includes(M_SIDECHAIN) || line.includes(M_META) || line.includes(M_TOOL_RESULT)) return;
    s.userTurns += 1;
    if (s.openingPrompt === "" && openingAttempts < 20) {
      openingAttempts += 1;
      const text = textOfUserMessage(parseLine(line));
      if (isUsableAsTitle(text)) s.openingPrompt = text;
    }
  });
  return s;
}

/**
 * Lists the conversations Claude has for a working directory, newest first.
 * Transcripts with no user turn are stubs and are left out. `trackedBy` maps
 * a session uuid to the boxes whose record points at it.
 */
export async function listConversations(
  env: HostEnv,
  workDir: string,
  trackedBy: Map<string, string[]>,
): Promise<ConversationSummary[]> {
  const dir = projectDirFor(env, workDir);
  if (dir === "") return [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: { summary: ConversationSummary; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const uuid = name.slice(0, -".jsonl".length);
    if (!UUID_RE.test(uuid)) continue;
    const file = path.join(dir, name);
    let stat;
    let buf: Buffer;
    try {
      stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      buf = await fs.readFile(file);
    } catch {
      continue;
    }
    const s = scanTranscript(buf);
    if (s.userTurns === 0) continue;

    let title: string;
    let titleSource: ConversationSummary["titleSource"];
    if (s.customTitle !== "") {
      title = s.customTitle;
      titleSource = "custom-title";
    } else if (s.aiTitle !== "") {
      title = s.aiTitle;
      titleSource = "ai-title";
    } else {
      title = condense(openingPromptTitle(s.openingPrompt), 70);
      titleSource = "prompt";
    }
    if (title === "") {
      title = uuid.slice(0, 8);
      titleSource = "none";
    }
    out.push({
      mtimeMs: stat.mtimeMs,
      summary: {
        sessionUuid: uuid,
        title,
        titleSource,
        turns: s.userTurns,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        sizeBytes: stat.size,
        lastPrompt: condense(s.lastPrompt, 160),
        trackedBy: [...(trackedBy.get(uuid) ?? [])],
      },
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.map((o) => o.summary);
}

/**
 * The title of one session's transcript: the custom title, the AI title, or
 * the condensed opening prompt. `""` when there is no transcript, no user
 * turn, or nothing usable.
 */
export async function titleForUuid(env: HostEnv, workDir: string, uuid: string): Promise<string> {
  if (workDir === "" || uuid === "") return "";
  let buf: Buffer;
  try {
    buf = await fs.readFile(transcriptPath(env, workDir, uuid));
  } catch {
    return "";
  }
  const s = scanTranscript(buf);
  if (s.userTurns === 0) return "";
  if (s.customTitle !== "") return s.customTitle;
  if (s.aiTitle !== "") return s.aiTitle;
  if (s.openingPrompt !== "") return condense(openingPromptTitle(s.openingPrompt), 70);
  return "";
}

/** Whether a session's transcript exists for a working directory. */
export async function transcriptExists(
  env: HostEnv,
  workDir: string,
  uuid: string,
): Promise<boolean> {
  if (workDir === "" || uuid === "") return false;
  try {
    return (await fs.stat(transcriptPath(env, workDir, uuid))).isFile();
  } catch {
    return false;
  }
}
