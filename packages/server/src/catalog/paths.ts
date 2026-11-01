// Where Claude Code keeps a working directory's transcripts.
import path from "node:path";
import type { HostEnv } from "../records/env.js";
import { claudeProjectsDir, hostToContainer } from "../records/env.js";

/** The longest encoded name Claude Code uses before it truncates and hashes. */
const MAX_ENCODED_LENGTH = 200;

/**
 * Claude Code's string hash: Java's `String.hashCode()` over UTF-16 code
 * units, as a signed 32-bit integer.
 */
export function claudePathHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Encodes a working directory the way Claude Code names its project folder:
 * the path the container sees, with every UTF-16 code unit outside
 * `[0-9A-Za-z]` replaced by `-`. A name longer than 200 characters is cut
 * to 200 and gets `-` plus the base-36 hash of the unencoded path, as Claude
 * Code 2.1 does.
 */
export function encodeProjectDir(workDir: string): string {
  const dir = hostToContainer(workDir);
  const encoded = dir.replace(/[^0-9A-Za-z]/g, "-");
  if (encoded.length <= MAX_ENCODED_LENGTH) return encoded;
  return `${encoded.slice(0, MAX_ENCODED_LENGTH)}-${Math.abs(claudePathHash(dir)).toString(36)}`;
}

/** `<projects store>/<encoded>` for a working directory, or `""` for an empty one. */
export function projectDirFor(env: HostEnv, workDir: string): string {
  if (workDir === "") return "";
  return path.join(claudeProjectsDir(env), encodeProjectDir(workDir));
}

/** The transcript file of one session in a working directory. */
export function transcriptPath(env: HostEnv, workDir: string, sessionUuid: string): string {
  return path.join(projectDirFor(env, workDir), `${sessionUuid}.jsonl`);
}
