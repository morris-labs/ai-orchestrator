// The SQLite mirror of builds. The engines own the build files; the server
// keeps the latest `BuildSummary` of every build it has seen, from
// `build.changed` events, so it knows which project and container hold a
// build and can admit that build's later events.
import { BuildSummarySchema, type AioEvent, type BuildSummary } from "@aio/contracts";
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

  /** Mirrors `build.changed` events; ignores every other event. */
  ingest(event: AioEvent): void {
    if (event.type === "build.changed") this.upsert(event.build);
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
