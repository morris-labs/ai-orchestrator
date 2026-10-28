// Where Claude Code keeps a working directory's transcripts.
import path from "node:path";
import type { HostEnv } from "../records/env.js";
import { homePaths, hostToContainer } from "../records/env.js";

/**
 * Encodes a working directory the way Claude Code names its project folder:
 * the path the container sees, with every UTF-16 code unit outside
 * `[0-9A-Za-z]` replaced by `-`.
 */
export function encodeProjectDir(workDir: string): string {
  return hostToContainer(workDir).replace(/[^0-9A-Za-z]/g, "-");
}

/** `~/.claude/projects/<encoded>` for a working directory, or `""` for an empty one. */
export function projectDirFor(env: HostEnv, workDir: string): string {
  if (workDir === "") return "";
  return path.join(homePaths(env).claudeProjects, encodeProjectDir(workDir));
}

/** The transcript file of one session in a working directory. */
export function transcriptPath(env: HostEnv, workDir: string, sessionUuid: string): string {
  return path.join(projectDirFor(env, workDir), `${sessionUuid}.jsonl`);
}
