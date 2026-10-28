// Runs git on the host, never prompting and always in the C locale.
import { execFile } from "node:child_process";

export interface GitResult {
  ok: boolean;
  /** Standard output on success, standard error on failure. */
  output: string;
}

/**
 * Runs `git -C dir args...`. Set `trim` to false for formats where leading
 * spaces matter, such as `status --porcelain -z`.
 */
export function git(
  dir: string,
  args: readonly string[],
  options: { timeoutMs?: number; trim?: boolean } = {},
): Promise<GitResult> {
  const { timeoutMs = 30000, trim = true } = options;
  const full = dir === "" ? [...args] : ["-C", dir, ...args];
  return new Promise((resolve) => {
    execFile(
      "git",
      full,
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        timeout: timeoutMs,
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ ok: false, output: "could not run git" });
          return;
        }
        if (error && error.killed) {
          resolve({ ok: false, output: "git timed out" });
          return;
        }
        const ok = !error;
        const output = ok ? stdout : stderr;
        resolve({ ok, output: trim ? output.trim() : output });
      },
    );
  });
}
