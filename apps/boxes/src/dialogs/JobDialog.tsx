// A job in a terminal, the CommandTerminalDialog of the Qt app: "Running:
// <command>", the streamed output, and "Finished." or "Finished (exit N)."
// when it ends.
import type { Job } from "@agentbox/contracts";
import { Button, Dialog, TerminalView, errorMessage, useApiClient } from "@agentbox/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** The status line for a job. */
export function jobLabel(job: Job | null, command: string): string {
  if (!job || job.status === "running") return `Running: ${job?.command ?? command}`;
  if (job.status === "failed" && job.exitCode === null) {
    return `Failed to start ${job.command}${job.error ? `: ${job.error.message}` : "."}`;
  }
  if (job.exitCode !== null && job.exitCode !== 0) return `Finished (exit ${job.exitCode}).`;
  return "Finished.";
}

/**
 * What to tell the person about a box-creation job that `waitForJob()`
 * returned: `null` when it finished, a note that it still runs when the wait
 * gave up first, else why it failed.
 */
export function createJobMessage(job: Job, deferredStart = false): string | null {
  if (job.status === "finished") return null;
  if (job.status === "running") {
    const base = `Creating the box is still running after a long wait (${job.command}). It appears in the list when it finishes.`;
    // The app stops waiting, so the steps it would take after the job don't run.
    return deferredStart
      ? `${base}\n\nThe app stopped waiting for it, so the project settings you edited aren't saved and the box doesn't start by itself. When it appears, edit the project settings again, then start the box.`
      : base;
  }
  return job.error?.message ?? `Creating the box failed (exit ${job.exitCode ?? "unknown"}).`;
}

/**
 * Polls `jobs.get` until the job leaves `running`, or until the deadline
 * passes. A failed poll is retried, up to `retries` failures in a row. When
 * `signal` aborts, the wait stops polling and rejects with the abort reason.
 */
export async function waitForJob(
  get: () => Promise<Job>,
  options: { intervalMs?: number; timeoutMs?: number; retries?: number; signal?: AbortSignal } = {},
): Promise<Job> {
  const interval = options.intervalMs ?? 500;
  const retries = options.retries ?? 3;
  const { signal } = options;
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  const sleep = () =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, interval);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  let failures = 0;
  for (;;) {
    signal?.throwIfAborted();
    let job: Job;
    try {
      job = await get();
      failures = 0;
    } catch (err) {
      signal?.throwIfAborted();
      failures += 1;
      if (failures > retries || Date.now() > deadline) throw err;
      await sleep();
      continue;
    }
    if (job.status !== "running") return job;
    if (Date.now() > deadline) return job;
    await sleep();
  }
}

export interface JobDialogProps {
  title: string;
  /** Draws the dialog above an open message box. */
  stacked?: boolean;
  job: Job;
  onClose: () => void;
  /** Called once with the finished job. */
  onDone?: (job: Job) => void;
  /** Rendered under the terminal once the job finished. */
  renderResult?: (job: Job) => ReactNode;
}

export function JobDialog({
  title,
  job: initial,
  onClose,
  onDone,
  renderResult,
  stacked,
}: JobDialogProps) {
  const client = useApiClient();
  const [job, setJob] = useState<Job>(initial);
  const [error, setError] = useState<string | null>(null);
  const reported = useRef(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    let live = true;
    // Closing the dialog stops the polling, not only the state updates.
    const abort = new AbortController();
    waitForJob(() => client.call("jobs.get", { params: { jobId: initial.id } }), {
      intervalMs: 1000,
      signal: abort.signal,
    })
      .then((j) => {
        if (!live) return;
        setJob(j);
        if (!reported.current) {
          reported.current = true;
          onDoneRef.current?.(j);
        }
      })
      .catch((err: unknown) => live && setError(errorMessage(err)));
    return () => {
      live = false;
      abort.abort();
    };
  }, [client, initial.id]);

  return (
    <Dialog
      stacked={stacked}
      title={title}
      width="min(900px, 92vw)"
      buttons={
        <Button primary onClick={onClose}>
          Close
        </Button>
      }
    >
      <div role="status" className={job.status === "failed" ? "ab-error-text" : undefined}>
        {jobLabel(job, initial.command)}
      </div>
      {error && <div className="ab-error-text">{error}</div>}
      <div className="bx-job-terminal">
        <TerminalView
          client={client}
          target={{ kind: "job", jobId: initial.id }}
          showBanner={false}
        />
      </div>
      {job.status !== "running" && renderResult?.(job)}
    </Dialog>
  );
}
