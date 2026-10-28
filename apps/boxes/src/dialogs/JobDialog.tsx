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

/** Polls `jobs.get` until the job leaves `running`. */
export async function waitForJob(
  get: () => Promise<Job>,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<Job> {
  const interval = options.intervalMs ?? 500;
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  for (;;) {
    const job = await get();
    if (job.status !== "running") return job;
    if (Date.now() > deadline) return job;
    await new Promise((r) => setTimeout(r, interval));
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
    waitForJob(() => client.call("jobs.get", { params: { jobId: initial.id } }), {
      intervalMs: 1000,
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
