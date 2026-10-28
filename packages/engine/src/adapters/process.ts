// Runs a CLI as a child process with a timeout, cancellation, and a line
// callback for streaming JSON output.
import { spawn } from "node:child_process";

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Written to the child's stdin, which is then closed. Absent closes stdin at once. */
  input?: string;
  /** Added to this process's environment. A `undefined` value removes the variable. */
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called for each complete stdout line, without the newline. */
  onLine?: (line: string) => void;
  /** Time between SIGTERM and SIGKILL. Default 3000 ms. */
  killGraceMs?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** The signal that ended the child, if any. */
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Set when the program could not start, such as `ENOENT`. */
  spawnError: NodeJS.ErrnoException | null;
}

/** Runs one command to completion. It never rejects; inspect the result. */
export function runProcess(opts: RunProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let cancelled = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    if (opts.signal?.aborted) {
      resolve({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        timedOut,
        cancelled: true,
        durationMs: 0,
        spawnError,
      });
      return;
    }

    // `detached` puts the child in its own process group, so a kill reaches
    // the tools it started as well.
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      signalTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => signalTree(child.pid, "SIGKILL"), opts.killGraceMs ?? 3000);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const emitLines = (chunk: string) => {
      if (!opts.onLine) return;
      pending += chunk;
      let index = pending.indexOf("\n");
      while (index >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        if (line.length > 0) opts.onLine(line);
        index = pending.indexOf("\n");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      emitLines(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // A child that exits before reading its input raises EPIPE here; the
    // exit code tells the real story.
    child.stdin.on("error", () => undefined);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.onLine && pending.trim().length > 0) opts.onLine(pending.replace(/\r$/, ""));
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        spawnError,
      });
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process is already gone.
    }
  }
}
