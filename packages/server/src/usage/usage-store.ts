// The SQLite mirror of usage samples and lease settlements, across every
// engine. `usage.samples` and `usage.get` answer from it.
import {
  BuildStepSchema,
  TimedUsageSampleSchema,
  type BuildStep,
  type BuildUsage,
  type LeaseSettlement,
  type TimedUsageSample,
  type UsageWindow,
  type Vendor,
} from "@aio/contracts";
import type { SqlDatabase } from "../api/core-interface.js";

type Row = { json: string };

/** One group of settlements as SQLite sums it. */
type TotalsRow = {
  key: string | null;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  premium_requests: number;
  cost_estimate: number;
};

const TOTALS = `COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tokens_in,
  COALESCE(SUM(tokens_out), 0) AS tokens_out,
  COALESCE(SUM(premium_requests), 0) AS premium_requests,
  COALESCE(SUM(cost_estimate), 0) AS cost_estimate`;

function totals(row: TotalsRow) {
  return {
    calls: row.calls,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    premiumRequests: row.premium_requests,
    costEstimate: row.cost_estimate,
  };
}

/** Compares rows by key with `compare`, with a `null` key last. */
function nullsLast<K>(compare: (a: K, b: K) => number) {
  return (a: { key: K | null }, b: { key: K | null }) => {
    if (a.key === null) return b.key === null ? 0 : 1;
    if (b.key === null) return -1;
    return compare(a.key, b.key);
  };
}

const STEP_ORDER: readonly BuildStep[] = BuildStepSchema.options;

function parseRows(rows: unknown[]): TimedUsageSample[] {
  return (rows as Row[]).map((r) => TimedUsageSampleSchema.parse(JSON.parse(r.json)));
}

export class UsageStore {
  /** `db` comes from `openDatabase()`, whose migrations create its tables. */
  constructor(private readonly db: SqlDatabase) {}

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
         (time, lease_id, run_id, build_id, seat, step, specialties, vendor, role, tokens_in,
          tokens_out, premium_requests, cost_estimate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        time,
        s.leaseId,
        s.runId,
        s.buildId ?? null,
        s.seat ?? null,
        s.step ?? null,
        s.specialties?.length ? JSON.stringify(s.specialties) : null,
        s.vendor,
        s.role,
        s.tokens.in,
        s.tokens.out,
        s.premiumRequests,
        s.costEstimate,
      );
  }

  /**
   * One build's settled usage, in total, by seat, by step, and by
   * specialty. It counts every call that names the build, the calls of a
   * review run the build started included. A call with several specialties
   * counts toward each of them.
   */
  buildUsage(buildId: string): BuildUsage {
    const group = (column: "seat" | "step") =>
      this.db
        .prepare(
          `SELECT ${column} AS key, ${TOTALS} FROM svc_lease_settlements
           WHERE build_id = ? GROUP BY ${column}`,
        )
        .all(buildId) as TotalsRow[];
    const total = this.db
      .prepare(`SELECT NULL AS key, ${TOTALS} FROM svc_lease_settlements WHERE build_id = ?`)
      .get(buildId) as TotalsRow;
    const specialties = this.db
      .prepare(
        `SELECT j.value AS key, ${TOTALS}
         FROM svc_lease_settlements, json_each(svc_lease_settlements.specialties) AS j
         WHERE build_id = ? GROUP BY j.value
         UNION ALL
         SELECT NULL AS key, ${TOTALS} FROM svc_lease_settlements
         WHERE build_id = ? AND specialties IS NULL HAVING COUNT(*) > 0`,
      )
      .all(buildId, buildId) as TotalsRow[];
    const seats = group("seat");
    const steps = group("step") as (TotalsRow & { key: BuildStep | null })[];
    return {
      buildId,
      total: totals(total),
      bySeat: seats
        .sort(nullsLast<string>((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
        .map((r) => ({ seat: r.key, ...totals(r) })),
      byStep: steps
        .sort(nullsLast<BuildStep>((a, b) => STEP_ORDER.indexOf(a) - STEP_ORDER.indexOf(b)))
        .map((r) => ({ step: r.key, ...totals(r) })),
      bySpecialty: specialties
        .sort(nullsLast<string>((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
        .map((r) => ({ specialty: r.key, ...totals(r) })),
    };
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

  /**
   * How many of a vendor's samples carry a legacy label: anything but an
   * account id (`VENDOR/NAME`), such as a Claude email or `codex-default`.
   */
  countLegacy(vendor: Vendor): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM svc_usage_samples WHERE vendor = ? AND instr(account, '/') = 0",
      )
      .get(vendor) as { n: number };
    return row.n;
  }

  /**
   * Relabels a vendor's legacy samples (see `countLegacy()`) with an account
   * id, in the column and in the stored JSON, so usage history carries over
   * to the account. Returns how many it relabeled.
   */
  relabelLegacy(vendor: Vendor, accountId: string): number {
    const r = this.db
      .prepare(
        `UPDATE svc_usage_samples SET account = ?, json = json_set(json, '$.account', ?)
         WHERE vendor = ? AND instr(account, '/') = 0`,
      )
      .run(accountId, accountId, vendor);
    return Number(r.changes);
  }

  /** Removes the samples of an account that no longer exists. */
  removeAccount(vendor: Vendor, account: string): number {
    const r = this.db
      .prepare("DELETE FROM svc_usage_samples WHERE vendor = ? AND account = ?")
      .run(vendor, account);
    return Number(r.changes);
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
