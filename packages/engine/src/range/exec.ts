// The engine's command runners. Both run on `runProcess`, so a timeout or a
// cancel kills the whole process group, and every child gets an environment
// built for its job (see `src/process/env.ts`).
import { constants } from "node:os";
import type { CommandOptions, CommandResult, CommandRunner } from "../core.js";
import { runProcess, type ProcessResult } from "../adapters/process.js";
import { profileForProgram } from "../process/env.js";

/** Maps a finished process to the core's result, with shell-style exit codes. */
export function toCommandResult(result: ProcessResult): CommandResult {
  const notStarted = result.spawnError !== null;
  let exitCode: number;
  if (result.spawnError) {
    exitCode = result.spawnError.code === "EACCES" ? 126 : 127;
  } else if (result.exitCode !== null) {
    exitCode = result.exitCode;
  } else if (result.signal) {
    exitCode = 128 + (constants.signals[result.signal] ?? 0);
  } else {
    exitCode = 1;
  }
  return {
    exitCode,
    stdout: result.stdout,
    stderr: result.stderr || (result.spawnError ? result.spawnError.message : ""),
    timedOut: result.timedOut,
    notStarted,
    signal: result.signal,
  };
}

/** Runs programs directly, without a shell. */
export class ProcessRunner implements CommandRunner {
  async run(
    program: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    const result = await runProcess({
      command: program,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
      envProfile: options.envProfile ?? profileForProgram(program, args),
      input: options.input,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return toCommandResult(result);
  }
}

/** The earlier name of `ProcessRunner`. */
export { ProcessRunner as ExecaRunner };

/**
 * Runs one command line through `sh -c`, for the policy's test and lint
 * commands. `program` is the command line; `args` are ignored. The command
 * runs code from the reviewed repository, so it gets no credentials.
 */
export class ShellRunner implements CommandRunner {
  constructor(private readonly inner: CommandRunner = new ProcessRunner()) {}

  run(
    commandLine: string,
    _args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    return this.inner.run("sh", ["-c", commandLine], { ...options, envProfile: "untrusted" });
  }
}
