// Runs external commands (git, gh, ss, tmux) behind an interface that tests replace.
import { runProcess } from "../adapters/process.js";
import { profileForProgram, type EnvProfile } from "../process/env.js";

export interface CommandResult {
  /** The exit code; 127 when the program doesn't exist, 124 on a timeout. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Added to the environment the profile allows; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /** Absent: `github` for `git` and `gh`, `untrusted` for everything else. */
  envProfile?: EnvProfile;
}

export interface CommandRunner {
  /** Runs a program without a shell. Never rejects for a failed command. */
  run(program: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

/** The real runner, on `runProcess`: a timeout kills the whole process group. */
export const execRunner: CommandRunner = {
  async run(program, args, options = {}) {
    const result = await runProcess({
      command: program,
      args: [...args],
      cwd: options.cwd ?? process.cwd(),
      env: options.env,
      envProfile: options.envProfile ?? profileForProgram(program),
      timeoutMs: options.timeoutMs ?? 15_000,
    });
    let code = result.exitCode ?? 1;
    if (result.spawnError) code = result.spawnError.code === "EACCES" ? 126 : 127;
    if (result.timedOut) code = 124;
    return { code, stdout: result.stdout, stderr: result.stderr };
  },
};
