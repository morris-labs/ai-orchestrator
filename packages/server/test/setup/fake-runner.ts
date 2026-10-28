// A recording `ProcessRunner` double for tests.
import type {
  ProcessRunner,
  RunOptions,
  RunResult,
  SpawnOptions,
  SpawnedProcess,
} from "../../src/jobs/process.js";

export interface FakeProcess extends SpawnedProcess {
  argv: string[];
  options: SpawnOptions;
  written: string[];
  killed: boolean;
  emit(data: string): void;
  exit(code: number | null, error?: string | null): void;
}

export type RunScript = (argv: string[], options: RunOptions) => Partial<RunResult>;

export class FakeRunner implements ProcessRunner {
  readonly runs: { argv: string[]; options: RunOptions }[] = [];
  readonly spawned: FakeProcess[] = [];

  constructor(private readonly script: RunScript = () => ({})) {}

  async run(
    command: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    const argv = [command, ...args];
    this.runs.push({ argv, options });
    return {
      code: 0,
      stdout: "",
      stderr: "",
      failedToStart: false,
      timedOut: false,
      ...this.script(argv, options),
    };
  }

  spawn(command: string, args: readonly string[], options: SpawnOptions = {}): SpawnedProcess {
    const data: ((chunk: Buffer) => void)[] = [];
    let onExit: ((code: number | null, error: string | null) => void) | null = null;
    let exited: [number | null, string | null] | null = null;
    const proc: FakeProcess = {
      argv: [command, ...args],
      options,
      written: [],
      killed: false,
      onData: (l) => data.push(l),
      onExit: (l) => {
        onExit = l;
        if (exited) l(...exited);
      },
      write: (d) => proc.written.push(d.toString()),
      kill: () => {
        proc.killed = true;
      },
      emit: (s) => data.forEach((l) => l(Buffer.from(s))),
      exit: (code, error = null) => {
        if (exited) return;
        exited = [code, error];
        onExit?.(code, error);
      },
    };
    this.spawned.push(proc);
    return proc;
  }
}

/** Waits until `check` returns true, polling every few milliseconds. */
export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for a condition.");
    await new Promise((r) => setTimeout(r, 5));
  }
}
