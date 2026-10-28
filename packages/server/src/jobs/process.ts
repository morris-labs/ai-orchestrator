// Child processes behind an interface, so tests replace them with a double.
import { spawn } from "node:child_process";

export interface RunResult {
  /** The exit code, or `null` when a signal or the timeout ended the process. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the process could not start, such as a missing program. */
  failedToStart: boolean;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to the process's standard input, which then closes. */
  input?: string;
}

export interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * Runs the program under a pseudo-terminal with `script(1)`, for programs
   * that prompt on a terminal, such as `ssh-copy-id`.
   */
  pty?: boolean;
}

/** A running process with merged output. */
export interface SpawnedProcess {
  onData(listener: (chunk: Buffer) => void): void;
  /** Called once; `code` is `null` when a signal ended the process or it failed to start. */
  onExit(listener: (code: number | null, error: string | null) => void): void;
  write(data: string | Buffer): void;
  kill(): void;
}

export interface ProcessRunner {
  /** Runs a program to completion and collects its output. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** Starts a program and streams its output. */
  spawn(command: string, args: readonly string[], options?: SpawnOptions): SpawnedProcess;
}

/** Quotes one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Joins an argv into the command line a person would type. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** The `ProcessRunner` that starts real processes. */
export class NodeProcessRunner implements ProcessRunner {
  run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const child = spawn(command, [...args], {
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const finish = (result: Omit<RunResult, "stdout" | "stderr" | "timedOut">) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ ...result, stdout, stderr, timedOut });
      };
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : undefined;
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => {
        stderr += err.message;
        finish({ code: null, failedToStart: true });
      });
      child.on("close", (code) => finish({ code, failedToStart: false }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input ?? "");
    });
  }

  spawn(command: string, args: readonly string[], options: SpawnOptions = {}): SpawnedProcess {
    const [cmd, argv] = options.pty
      ? ["script", ["-q", "-f", "-e", "-c", commandLine([command, ...args]), "/dev/null"]]
      : [command, [...args]];
    const child = spawn(cmd, argv, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const dataListeners: ((chunk: Buffer) => void)[] = [];
    let exitListener: ((code: number | null, error: string | null) => void) | null = null;
    let exited: [number | null, string | null] | null = null;
    const emitData = (chunk: Buffer) => dataListeners.forEach((l) => l(chunk));
    const emitExit = (code: number | null, error: string | null) => {
      if (exited) return;
      exited = [code, error];
      exitListener?.(code, error);
    };
    child.stdout.on("data", emitData);
    child.stderr.on("data", emitData);
    child.stdin.on("error", () => undefined);
    child.on("error", (err) => emitExit(null, err.message));
    child.on("close", (code) => emitExit(code, null));
    return {
      onData: (l) => dataListeners.push(l),
      onExit: (l) => {
        exitListener = l;
        if (exited) l(...exited);
      },
      write: (data) => {
        if (!child.stdin.destroyed) child.stdin.write(data);
      },
      kill: () => {
        child.kill("SIGTERM");
      },
    };
  }
}
