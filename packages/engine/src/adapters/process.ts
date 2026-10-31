// Runs a CLI as a child process with a timeout, cancellation, and a line
// callback for streaming JSON output.
import { spawn } from "node:child_process";
import { trackChild } from "../process/children.js";
import { credentialsFor } from "../process/credentials.js";
import { childEnv, type EnvProfile } from "../process/env.js";

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Written to the child's stdin, which is then closed. Absent closes stdin at once. */
  input?: string;
  /**
   * Added to the environment the profile allows. A `undefined` value removes
   * the variable.
   */
  env?: Record<string, string | undefined>;
  /**
   * Which of this process's variables the child inherits (see
   * `src/process/env.ts`). Default `untrusted`: no credentials.
   */
  envProfile?: EnvProfile;
  /**
   * The profile's credentials, when the caller already got them from the
   * broker. Absent means `runProcess` asks the broker itself. `env` wins
   * over these.
   */
  credentials?: Record<string, string>;
  /** Kills the child after this many milliseconds. Absent or 0 means no limit. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called for each complete stdout line, without the newline. */
  onLine?: (line: string) => void;
  /** Time between SIGTERM and SIGKILL. Default 3000 ms. */
  killGraceMs?: number;
  /**
   * How long the call waits, after the child itself exits, for the processes
   * it left behind to close its output. When `timeoutMs` or `signal` is set
   * and they don't close it in time, `runProcess` kills the process group.
   * Default 2000 ms.
   */
  exitDrainMs?: number;
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
export async function runProcess(opts: RunProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const profile = opts.envProfile ?? "untrusted";
  const credentials = opts.credentials ?? (await credentialsFor(profile, opts.command));
  const env = childEnv(profile, { ...credentials, ...opts.env });

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
    // The group outlives a crashed engine; the record lets the next one stop it.
    const untrack =
      child.pid !== undefined && process.platform !== "win32"
        ? trackChild(child.pid)
        : () => undefined;

    let leaderExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let killing = false;
    const grace = opts.killGraceMs ?? 3000;

    // Ends the call without waiting for `close`. It runs only after SIGKILL
    // has gone to the group: whatever still holds the pipes then left the
    // group, and must not keep the call open.
    const abandonPipes = () => {
      if (settled) return;
      if (leaderExit === undefined) {
        killTimer = setTimeout(abandonPipes, grace);
        killTimer.unref();
        return;
      }
      child.stdout.destroy();
      child.stderr.destroy();
      finish(leaderExit.code, leaderExit.signal);
    };

    // Signals the whole group, even after the child itself has exited: a
    // grandchild that still holds stdout or stderr keeps `close` from firing.
    const kill = () => {
      if (settled || killing) return;
      if (process.platform === "win32" && leaderExit !== undefined) return;
      killing = true;
      signalTree(child.pid, "SIGTERM", leaderExit === undefined);
      killTimer = setTimeout(() => {
        signalTree(child.pid, "SIGKILL", leaderExit === undefined);
        killTimer = setTimeout(abandonPipes, grace);
        killTimer.unref();
      }, grace);
      killTimer.unref();
    };

    const limit = opts.timeoutMs ?? 0;
    const timer =
      limit > 0 && Number.isFinite(limit)
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, limit)
        : undefined;
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
      untrack();
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
    child.on("exit", (code, signal) => {
      leaderExit = { code, signal };
      // A call with a time limit or a cancel signal must not stay open for a
      // process that the child left running with its output pipes.
      if (killing || (limit <= 0 && !opts.signal)) return;
      const drain = setTimeout(kill, opts.exitDrainMs ?? 2000);
      drain.unref();
      child.once("close", () => clearTimeout(drain));
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Signals the process group that `pid` leads. `leaderAlive` allows a fallback
 * to `pid` alone. Once the leader has exited, its pid can belong to another
 * process, so only the group is signalled: the kernel doesn't reuse a group
 * id while any member lives.
 */
function signalTree(pid: number | undefined, signal: NodeJS.Signals, leaderAlive: boolean): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    if (!leaderAlive) return;
    try {
      process.kill(pid, signal);
    } catch {
      // The process is already gone.
    }
  }
}
