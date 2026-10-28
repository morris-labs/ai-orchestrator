// The SQLite mirror of usage samples and lease settlements, across every
// engine. `usage.samples` and `usage.get` answer from it.
import {
  TimedUsageSampleSchema,
  type LeaseSettlement,
  type TimedUsageSample,
  type UsageWindow,
  type Vendor,
} from "@agentbox/contracts";
import type { SqlDatabase } from "../api/core-interface.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS svc_usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  vendor TEXT NOT NULL,
  account TEXT NOT NULL,
  window TEXT NOT NULL,
  project_id TEXT,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS svc_usage_samples_vendor ON svc_usage_samples (vendor, window, time_ms);
CREATE TABLE IF NOT EXISTS svc_lease_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  role TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  premium_requests REAL NOT NULL,
  cost_estimate REAL NOT NULL
);
`;

type Row = { json: string };

function parseRows(rows: unknown[]): TimedUsageSample[] {
  return (rows as Row[]).map((r) => TimedUsageSampleSchema.parse(JSON.parse(r.json)));
}

export class UsageStore {
  constructor(private readonly db: SqlDatabase) {
    db.exec(SCHEMA);
  }

  /** Stores one sample. */
  record(sample: TimedUsageSample, projectId: string | null = null): void {
    const parsed = TimedUsageSampleSchema.parse(sample);
    this.db
      .prepare(
        `INSERT INTO svc_usage_samples (time, time_ms, vendor, account, window, project_id, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.time,
        Date.parse(parsed.time),
        parsed.vendor,
        parsed.account,
        parsed.window,
        projectId,
        JSON.stringify(parsed),
      );
  }

  /** Stores the actual usage of one call made under a lease. */
  recordSettlement(s: LeaseSettlement, time: string): void {
    this.db
      .prepare(
        `INSERT INTO svc_lease_settlements
         (time, lease_id, run_id, vendor, role, tokens_in, tokens_out, premium_requests, cost_estimate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        time,
        s.leaseId,
        s.runId,
        s.vendor,
        s.role,
        s.tokens.in,
        s.tokens.out,
        s.premiumRequests,
        s.costEstimate,
      );
  }

  /** Samples matching the query, oldest first. `since` and `until` are inclusive. */
  samples(q: { vendor?: Vendor; since?: string; until?: string }): TimedUsageSample[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.vendor) {
      where.push("vendor = ?");
      params.push(q.vendor);
    }
    if (q.since) {
      where.push("time_ms >= ?");
      params.push(Date.parse(q.since));
    }
    if (q.until) {
      where.push("time_ms <= ?");
      params.push(Date.parse(q.until));
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return parseRows(
      this.db
        .prepare(`SELECT json FROM svc_usage_samples ${clause} ORDER BY time_ms, id`)
        .all(...params),
    );
  }

  /** The newest sample for a vendor in a window, optionally for one account. */
  latest(vendor: Vendor, window: UsageWindow, account?: string): TimedUsageSample | undefined {
    const rows =
      account === undefined
        ? this.db
            .prepare(
              `SELECT json FROM svc_usage_samples WHERE vendor = ? AND window = ?
               ORDER BY time_ms DESC, id DESC LIMIT 1`,
            )
            .all(vendor, window)
        : this.db
            .prepare(
              `SELECT json FROM svc_usage_samples WHERE vendor = ? AND window = ? AND account = ?
               ORDER BY time_ms DESC, id DESC LIMIT 1`,
            )
            .all(vendor, window, account);
    return parseRows(rows)[0];
  }

  /** Samples for a vendor, window, and account taken at or after `sinceMs`, oldest first. */
  recent(
    vendor: Vendor,
    window: UsageWindow,
    account: string,
    sinceMs: number,
  ): TimedUsageSample[] {
    return parseRows(
      this.db
        .prepare(
          `SELECT json FROM svc_usage_samples
           WHERE vendor = ? AND window = ? AND account = ? AND time_ms >= ?
           ORDER BY time_ms, id`,
        )
        .all(vendor, window, account, sinceMs),
    );
  }

  /** The accounts a vendor has samples for, sorted. */
  accounts(vendor: Vendor): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT account FROM svc_usage_samples WHERE vendor = ? ORDER BY account")
        .all(vendor) as { account: string }[]
    ).map((r) => r.account);
  }
}
