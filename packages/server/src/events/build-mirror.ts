// The SQLite mirror of builds. The engines own the build files; the server
// keeps the latest `BuildSummary` of every build it has seen, from
// `build.changed` events, so it knows which project and container hold a
// build and can admit that build's later events. It also keeps each build's
// team chat messages and its tasks, for the build view.
import {
  BuildSummarySchema,
  BuildTaskStatusSchema,
  MessageSchema,
  type AioEvent,
  type BuildSummary,
  type BuildTaskView,
  type EventOf,
  type Message,
} from "@aio/contracts";
import type { SqlDatabase } from "../api/core-interface.js";

export class BuildMirror {
  /** `db` comes from `openDatabase()`, whose migrations create its tables. */
  constructor(private readonly db: SqlDatabase) {}

  /** Stores a build unless the mirror already has a newer state of it. */
  upsert(build: BuildSummary): void {
    const current = this.get(build.id);
    if (current && current.updatedAt > build.updatedAt) return;
    this.db
      .prepare(
        `INSERT INTO svc_builds (id, project_id, container, slug, status, created_at, updated_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id,
           container = excluded.container, slug = excluded.slug, status = excluded.status,
           updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(
        build.id,
        build.projectId,
        build.container,
        build.slug,
        build.status,
        build.createdAt,
        build.updatedAt,
        JSON.stringify(build),
      );
  }

  /** Mirrors build, task, and message events; ignores every other event. */
  ingest(event: AioEvent): void {
    if (event.type === "build.changed") this.upsert(event.build);
    else if (event.type === "message.sent") this.addMessage(event.message);
    else if (event.type === "build.task.changed") this.setTask(event);
  }

  /** Stores a message of a known build. A message the mirror holds stays as it is. */
  addMessage(message: Message): void {
    if (!this.get(message.buildId)) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO svc_build_messages (build_id, id, num, json) VALUES (?, ?, ?, ?)`,
      )
      .run(message.buildId, message.id, Number(message.id.slice(1)), JSON.stringify(message));
  }

  /**
   * Stores a task's state. An event that names no milestone keeps the one
   * an earlier event named.
   */
  private setTask(event: EventOf<"build.task.changed">): void {
    if (!this.get(event.buildId)) return;
    this.db
      .prepare(
        `INSERT INTO svc_build_tasks (build_id, task_id, status, milestone, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (build_id, task_id) DO UPDATE SET status = excluded.status,
           milestone = COALESCE(excluded.milestone, svc_build_tasks.milestone),
           updated_at = excluded.updated_at`,
      )
      .run(event.buildId, event.taskId, event.status, event.milestone ?? null, event.time);
  }

  /** A build's messages, oldest first, or `undefined` for a build the mirror doesn't hold. */
  messages(buildId: string): Message[] | undefined {
    if (!this.get(buildId)) return undefined;
    const rows = this.db
      .prepare(`SELECT json FROM svc_build_messages WHERE build_id = ? ORDER BY num`)
      .all(buildId) as { json: string }[];
    return rows.map((r) => MessageSchema.parse(JSON.parse(r.json)));
  }

  /** A build's tasks by task id, or `undefined` for a build the mirror doesn't hold. */
  tasks(buildId: string): BuildTaskView[] | undefined {
    if (!this.get(buildId)) return undefined;
    const rows = this.db
      .prepare(
        `SELECT task_id, status, milestone, updated_at FROM svc_build_tasks
         WHERE build_id = ? ORDER BY task_id`,
      )
      .all(buildId) as {
      task_id: string;
      status: string;
      milestone: string | null;
      updated_at: string;
    }[];
    return rows.map((r) => ({
      taskId: r.task_id,
      status: BuildTaskStatusSchema.parse(r.status),
      milestone: r.milestone,
      updatedAt: r.updated_at,
    }));
  }

  get(buildId: string): BuildSummary | undefined {
    const row = this.db.prepare("SELECT json FROM svc_builds WHERE id = ?").get(buildId) as
      { json: string } | undefined;
    return row ? BuildSummarySchema.parse(JSON.parse(row.json)) : undefined;
  }

  /** Every build, or one project's builds, newest first. */
  list(projectId?: string): BuildSummary[] {
    const rows = (
      projectId === undefined
        ? this.db.prepare(`SELECT json FROM svc_builds ORDER BY created_at DESC, id DESC`).all()
        : this.db
            .prepare(
              `SELECT json FROM svc_builds WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
            )
            .all(projectId)
    ) as { json: string }[];
    return rows.map((r) => BuildSummarySchema.parse(JSON.parse(r.json)));
  }
}
