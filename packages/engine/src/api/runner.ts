// Runs external commands (git, gh, ss, tmux) behind an interface that tests replace.
import { execFile } from "node:child_process";

export interface CommandResult {
  /** The exit code; 127 when the program doesn't exist, 124 on a timeout. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  /** Runs a program without a shell. Never rejects for a failed command. */
  run(program: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

/** The real runner, on `child_process.execFile`. */
export const execRunner: CommandRunner = {
  run(program, args, options = {}) {
    return new Promise((resolve) => {
      execFile(
        program,
        [...args],
        {
          cwd: options.cwd,
          env: options.env ?? process.env,
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ code: 0, stdout, stderr });
          const e = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
          let code = typeof e.code === "number" ? e.code : 1;
          if (e.code === "ENOENT") code = 127;
          if (e.killed) code = 124;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
  },
};
