// Turns run and box events into `notification` events, as the settings
// toggles allow, and keeps them in SQLite for `notifications.list`.
import { randomUUID } from "node:crypto";
import {
  NotificationSchema,
  type AioEvent,
  type EventOf,
  type GlobalSettings,
  type Notification,
  type NotificationToggles,
  type RunStatus,
} from "@aio/contracts";
import type { EventInput, SqlDatabase } from "../api/core-interface.js";
import type { UsageAlert } from "../usage/watcher.js";

export interface NotifierOptions {
  db: SqlDatabase;
  settings: () => GlobalSettings;
  emit: (event: EventInput) => AioEvent;
  /** Tells a box's session that the run holding its edits has ended. */
  releaseBox?: (boxId: string) => void;
  idFn?: () => string;
}

type Draft = Omit<Notification, "notificationId" | "read">;

export class Notifier {
  private readonly runStatus = new Map<string, RunStatus>();
  private readonly roundsSeen = new Set<string>();

  /** `opts.db` comes from `openDatabase()`, whose migrations create its tables. */
  constructor(private readonly opts: NotifierOptions) {}

  private toggles(): NotificationToggles {
    return this.opts.settings().notifications;
  }

  /** Handles one event from the hub. Ignores `notification` events. */
  ingest(event: AioEvent): void {
    if (event.type === "run.changed") this.onRun(event);
    else if (event.type === "terminal.ended") this.onTerminal(event);
  }

  private onRun(event: EventOf<"run.changed">): void {
    const run = event.run;
    const previous = this.runStatus.has(run.id)
      ? this.runStatus.get(run.id)
      : this.notifiedEnd(run.id, run.status);
    this.runStatus.set(run.id, run.status);
    const toggles = this.toggles();
    const label = run.request.tip ?? run.request.repoPath;

    if (run.status !== previous) {
      if (run.boxId && ["finished", "failed", "cancelled"].includes(run.status)) {
        this.opts.releaseBox?.(run.boxId);
      }
      if (run.status === "waiting_decision" && toggles.decisionNeeded) {
        this.notify({
          kind: "decision_needed",
          title: "Run needs a decision",
          body: run.decision?.message ?? `The run on ${label} waits for you.`,
          runId: run.id,
          boxId: run.boxId ?? null,
          severity: "warning",
        });
      } else if (run.status === "finished") {
        // A clean pre-push run is `ready_to_push`, under its own toggle;
        // every other finish is `run_finished`.
        const ready =
          run.stopReason === "clean" &&
          run.request.pipeline === "pre-push" &&
          !run.request.readOnly;
        if (ready ? toggles.readyToPush : toggles.runFinished)
          this.notify({
            kind: ready ? "ready_to_push" : "run_finished",
            title: ready ? "Branch is ready to push" : "Run finished",
            body: ready
              ? `The review of ${label} found nothing left to fix.`
              : `The run on ${label} stopped: ${run.stopReason ?? "finished"}.`,
            runId: run.id,
            boxId: run.boxId ?? null,
            severity: "info",
          });
      } else if (run.status === "failed" && toggles.runFinished) {
        this.notify({
          kind: "run_finished",
          title: "Run failed",
          body: run.error ?? `The run on ${label} failed.`,
          runId: run.id,
          boxId: run.boxId ?? null,
          severity: "error",
        });
      }
    }

    const summary = event.roundSummary;
    if (summary) {
      const key = `${summary.runId}|${summary.round}`;
      if (!this.roundsSeen.has(key)) {
        this.roundsSeen.add(key);
        if (
          this.stored(summary.runId, ["round_summary"], null, `Round ${summary.round} finished`)
        ) {
          return;
        }
        if (toggles.roundSummary) {
          const raised = Object.values(summary.perVendor).reduce((a, s) => a + (s?.raised ?? 0), 0);
          this.notify({
            kind: "round_summary",
            title: `Round ${summary.round} finished`,
            body: `${raised} findings raised, ${summary.fixed} fixed, cost $${summary.costUsd.toFixed(2)}.`,
            runId: summary.runId,
            boxId: run.boxId ?? null,
            severity: "info",
          });
        }
      }
    }
  }

  private onTerminal(event: EventOf<"terminal.ended">): void {
    if (!event.unexpected || event.kind !== "session" || !this.toggles().boxEnded) return;
    this.notify({
      kind: "box_ended",
      title: "Box session ended",
      body:
        event.exitCode === null
          ? "The session ended unexpectedly."
          : `The session ended unexpectedly with exit code ${event.exitCode}.`,
      runId: null,
      boxId: event.boxId,
      severity: "warning",
    });
  }

  /**
   * The status memory doesn't know after a restart: a run that already got
   * its "finished" or "failed" notification counts as already in that
   * status, so the first `run.changed` after the restart doesn't repeat it.
   * Only the end states are seeded, since a run can wait for a decision
   * more than once.
   */
  private notifiedEnd(runId: string, status: RunStatus): RunStatus | undefined {
    if (status === "finished" && this.stored(runId, ["run_finished", "ready_to_push"], "info"))
      return status;
    if (status === "failed" && this.stored(runId, ["run_finished"], "error")) return status;
    return undefined;
  }

  /** Whether a stored notification for the run has one of the kinds, and the severity or title. */
  private stored(
    runId: string,
    kinds: Notification["kind"][],
    severity: Notification["severity"] | null,
    title: string | null = null,
  ): boolean {
    const row = this.opts.db
      .prepare(
        `SELECT 1 FROM svc_notifications
         WHERE json_extract(json, '$.runId') = ?
           AND json_extract(json, '$.kind') IN (${kinds.map(() => "?").join(", ")})
           AND (? IS NULL OR json_extract(json, '$.severity') = ?)
           AND (? IS NULL OR json_extract(json, '$.title') = ?)
         LIMIT 1`,
      )
      .get(runId, ...kinds, severity, severity, title, title);
    return row !== undefined;
  }

  private notify(draft: Draft): void {
    const notification = NotificationSchema.parse({
      ...draft,
      notificationId: this.opts.idFn?.() ?? randomUUID(),
      read: false,
    });
    this.opts.db
      .prepare("INSERT INTO svc_notifications (id, read, json) VALUES (?, 0, ?)")
      .run(notification.notificationId, JSON.stringify(notification));
    this.opts.emit({ type: "notification", ...notification });
  }

  /**
   * Stores and sends a usage watcher alert. Usage alerts have no toggle: they
   * are how the owner learns to pause a build, since nothing pauses on its own.
   */
  usageAlert(alert: UsageAlert): void {
    this.notify({
      kind: "usage_alert",
      title: alert.title,
      body: `${alert.body} Tell the Project manager to pause or continue.`,
      runId: null,
      boxId: alert.boxId,
      ...(alert.buildId === null ? {} : { buildId: alert.buildId }),
      severity: "warning",
    });
  }

  /** Whether a build already got a usage alert, such as before a restart. */
  hasBuildAlert(buildId: string): boolean {
    const row = this.opts.db
      .prepare(
        `SELECT 1 FROM svc_notifications
         WHERE json_extract(json, '$.kind') = 'usage_alert'
           AND json_extract(json, '$.buildId') = ?
         LIMIT 1`,
      )
      .get(buildId);
    return row !== undefined;
  }

  /** Notifications, newest first. */
  list(q: { unread?: boolean } = {}): Notification[] {
    const clause = q.unread === undefined ? "" : `WHERE read = ${q.unread ? 0 : 1}`;
    const rows = this.opts.db
      .prepare(`SELECT read, json FROM svc_notifications ${clause} ORDER BY seq DESC`)
      .all() as { read: number; json: string }[];
    return rows.map((r) => NotificationSchema.parse({ ...JSON.parse(r.json), read: r.read === 1 }));
  }

  /** Marks a notification read; false when there is no such notification. */
  markRead(id: string): boolean {
    const result = this.opts.db
      .prepare("UPDATE svc_notifications SET read = 1 WHERE id = ?")
      .run(id);
    return Number(result.changes) > 0;
  }
}
