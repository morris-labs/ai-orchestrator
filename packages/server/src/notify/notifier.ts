// Turns run and box events into `notification` events, as the settings
// toggles allow, and keeps them in SQLite for `notifications.list`.
import { randomUUID } from "node:crypto";
import {
  NotificationSchema,
  type AgentBoxEvent,
  type EventOf,
  type GlobalSettings,
  type Notification,
  type NotificationToggles,
  type RunStatus,
} from "@agentbox/contracts";
import type { EventInput, SqlDatabase } from "../api/core-interface.js";

export interface NotifierOptions {
  db: SqlDatabase;
  settings: () => GlobalSettings;
  emit: (event: EventInput) => AgentBoxEvent;
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
  ingest(event: AgentBoxEvent): void {
    if (event.type === "run.changed") this.onRun(event);
    else if (event.type === "terminal.ended") this.onTerminal(event);
  }

  private onRun(event: EventOf<"run.changed">): void {
    const run = event.run;
    const previous = this.runStatus.get(run.id);
    this.runStatus.set(run.id, run.status);
    const toggles = this.toggles();
    const label = run.request.tip ?? run.request.repoPath;

    if (run.status !== previous) {
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
