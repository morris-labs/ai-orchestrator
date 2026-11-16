// Long-running host commands (image builds, setup fixes, ssh-copy-id, box
// creation, Convert to Worktree). A job keeps its terminal output so a client
// that connects late to `jobs.stream` sees it from the start.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Job } from "@aio/contracts";
import { toApiError } from "../api/errors.js";
import type { SpawnedProcess } from "./process.js";

/** The most output a job keeps; older bytes are dropped from the front. */
export const JOB_OUTPUT_LIMIT = 2 * 1024 * 1024;
/** How many finished jobs the manager keeps; older ones are dropped first. */
export const FINISHED_JOB_LIMIT = 50;
/** How long a finished job stays readable. */
export const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;

/** What a job's body uses to talk to its terminal. */
export interface JobIO {
  write(data: string | Buffer): void;
  /** Registers the receiver of the terminal's input (binary frames or `input` messages). */
  onInput(listener: (data: Buffer) => void): void;
  onResize(listener: (cols: number, rows: number) => void): void;
  /** Registers what ends the job early, such as killing its process at shutdown. */
  onStop(listener: () => void): void;
}

/** What a job's body returns. A thrown error fails the job with its code. */
export interface JobOutcome {
  exitCode: number | null;
  result?: unknown;
  /** Marks the job `failed` without throwing, such as a command that exited non-zero. */
  failed?: boolean;
}

export type JobBody = (io: JobIO) => Promise<JobOutcome>;

export interface JobStart {
  kind: Job["kind"];
  command: string;
  boxId?: string | null;
}

interface JobEntry {
  job: Job;
  chunks: Buffer[];
  size: number;
  events: EventEmitter;
  input: ((data: Buffer) => void) | null;
  resize: ((cols: number, rows: number) => void) | null;
  stop: (() => void) | null;
  /** When the job finished, in epoch milliseconds. */
  finishedMs: number | null;
}

/** A client's view of a job's terminal. */
export interface JobAttachment {
  /** The output so far. */
  backlog: Buffer;
  onData(listener: (chunk: Buffer) => void): void;
  onDone(listener: (job: Job) => void): void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

export class JobManager {
  private readonly jobs = new Map<string, JobEntry>();

  constructor(
    private readonly options: {
      now?: () => Date;
      /** How many finished jobs to keep. */
      finishedLimit?: number;
      /** How long to keep a finished job, in milliseconds. */
      finishedTtlMs?: number;
      /** Called when a job ends, for the `terminal.ended` event. */
      onFinished?: (job: Job) => void;
    } = {},
  ) {}

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /** Starts a job and returns its state at once. */
  start(spec: JobStart, body: JobBody): Job {
    const job: Job = {
      id: randomUUID(),
      kind: spec.kind,
      boxId: spec.boxId ?? null,
      command: spec.command,
      status: "running",
      exitCode: null,
      error: null,
      result: null,
      startedAt: this.now(),
      finishedAt: null,
    };
    const entry: JobEntry = {
      job,
      chunks: [],
      size: 0,
      events: new EventEmitter(),
      input: null,
      resize: null,
      stop: null,
      finishedMs: null,
    };
    this.evict();
    this.jobs.set(job.id, entry);
    const io: JobIO = {
      write: (data) => this.append(entry, typeof data === "string" ? Buffer.from(data) : data),
      onInput: (l) => (entry.input = l),
      onResize: (l) => (entry.resize = l),
      onStop: (l) => (entry.stop = l),
    };
    // Run on the next tick so the caller gets the job before any output.
    setImmediate(() => {
      body(io).then(
        (outcome) => {
          this.finish(entry, {
            status: outcome.failed ? "failed" : "finished",
            exitCode: outcome.exitCode,
            result: outcome.result ?? null,
            error: outcome.failed
              ? {
                  code: "conflict",
                  message: `The command exited with code ${outcome.exitCode ?? "unknown"}.`,
                }
              : null,
          });
        },
        (err: unknown) => {
          const failure = toApiError(err);
          this.append(entry, Buffer.from(`\r\n${failure.message}\r\n`));
          this.finish(entry, {
            status: "failed",
            exitCode: null,
            result: null,
            error: failure.toBody().error,
          });
        },
      );
    });
    return { ...job };
  }

  get(jobId: string): Job | undefined {
    const entry = this.jobs.get(jobId);
    return entry ? { ...entry.job } : undefined;
  }

  /** Attaches a client to a job's terminal, or returns `undefined` for an unknown job. */
  attach(jobId: string): JobAttachment | undefined {
    const entry = this.jobs.get(jobId);
    if (!entry) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners: [string, (...args: any[]) => void][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const on = (event: string, l: (...args: any[]) => void) => {
      entry.events.on(event, l);
      listeners.push([event, l]);
    };
    return {
      backlog: Buffer.concat(entry.chunks),
      onData: (l) => on("data", l),
      onDone: (l) => {
        if (entry.job.status !== "running") setImmediate(() => l({ ...entry.job }));
        else on("done", l);
      },
      write: (data) => entry.input?.(data),
      resize: (cols, rows) => entry.resize?.(cols, rows),
      detach: () => listeners.forEach(([e, l]) => entry.events.off(e, l)),
    };
  }

  private append(entry: JobEntry, chunk: Buffer): void {
    if (chunk.length === 0) return;
    entry.chunks.push(chunk);
    entry.size += chunk.length;
    while (entry.size > JOB_OUTPUT_LIMIT && entry.chunks.length > 1) {
      entry.size -= (entry.chunks.shift() as Buffer).length;
    }
    entry.events.emit("data", chunk);
  }

  /** Drops finished jobs past their age, then the oldest past the count limit. */
  private evict(): void {
    const limit = this.options.finishedLimit ?? FINISHED_JOB_LIMIT;
    const cutoff = Date.now() - (this.options.finishedTtlMs ?? FINISHED_JOB_TTL_MS);
    const finished = [...this.jobs.values()]
      .filter((e) => e.finishedMs !== null)
      .sort((a, b) => (a.finishedMs as number) - (b.finishedMs as number));
    let excess = finished.length - limit;
    for (const e of finished) {
      if (excess > 0 || (e.finishedMs as number) < cutoff) {
        this.jobs.delete(e.job.id);
        excess -= 1;
      }
    }
  }

  /** Stops one running command, for an upgrade whose deadline expired. */
  stop(jobId: string): void {
    this.jobs.get(jobId)?.stop?.();
  }

  /**
   * Stops every running job, as at shutdown, and waits until each has
   * finished or `timeoutMs` passes. A job without a stop handler is waited for.
   */
  async stopAll(timeoutMs = 5000): Promise<void> {
    const running = [...this.jobs.values()].filter((e) => e.job.status === "running");
    const done = running.map(
      (e) =>
        new Promise<void>((resolve) => {
          e.events.once("done", () => resolve());
          try {
            e.stop?.();
          } catch {
            // A failing stop leaves the job to finish on its own.
          }
        }),
    );
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(done),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  private finish(entry: JobEntry, fields: Pick<Job, "status" | "exitCode" | "result" | "error">) {
    entry.finishedMs = Date.now();
    Object.assign(entry.job, fields, { finishedAt: this.now() });
    entry.events.emit("done", { ...entry.job });
    this.options.onFinished?.({ ...entry.job });
  }
}

/**
 * Runs a spawned process as a job's body: streams its output, forwards
 * terminal input, and fails the job on a non-zero exit.
 */
export function processJob(io: JobIO, proc: SpawnedProcess): Promise<JobOutcome> {
  proc.onData((chunk) => io.write(chunk));
  io.onInput((data) => proc.write(data));
  io.onStop(() => proc.kill());
  return new Promise((resolve) => {
    proc.onExit((code, error) => {
      if (error) io.write(`\r\nFailed to start: ${error}\r\n`);
      resolve({ exitCode: code, failed: code !== 0 });
    });
  });
}
