// Process runners built on execa.
import { execa } from "execa";
import type { CommandOptions, CommandResult, CommandRunner } from "../core.js";

/** Runs programs directly, without a shell. */
export class ExecaRunner implements CommandRunner {
  async run(program: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    const result = await execa(program, [...args], {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      timeout: options.timeoutMs,
      cancelSignal: options.signal,
      reject: false,
      stripFinalNewline: false,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      timedOut: Boolean(result.timedOut),
    };
  }
}

/**
 * Runs one command line through `sh -c`, for the policy's test and lint
 * commands. `program` is the command line; `args` are ignored.
 */
export class ShellRunner implements CommandRunner {
  constructor(private readonly inner: CommandRunner = new ExecaRunner()) {}

  run(commandLine: string, _args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    return this.inner.run("sh", ["-c", commandLine], options);
  }
}
