// The usage estimate table: the corrected usage of each finished build, by
// size, which the Analyst's usage estimate scales from.
//
// A build's corrected usage is the tokens in of its settled agent calls:
// planning, every step, and its review runs, with each resumed session
// counted once, since the adapters record only a resumed turn's own usage.
// The Project manager's session isn't part of it, as it isn't part of the
// estimate. The table lives in `PROJECT_ROOT/.aio/builds/usage-history.json`,
// one entry per build, so a build that finishes again after a restart
// replaces its entry instead of adding one.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BuildSizeSchema, RUNS_DIR, type AioEvent, type BuildSize } from "@aio/contracts";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "../run/files.js";
import type { BuildContext } from "./context.js";
import { buildsDir } from "./store.js";

/** The table's file name, in the project's builds directory. */
export const USAGE_HISTORY_FILE = "usage-history.json";

const EntrySchema = z.object({
  buildId: z.string().min(1),
  slug: z.string().min(1),
  size: BuildSizeSchema,
  tasks: z.number().int().positive(),
  tokensIn: z.number().int().nonnegative(),
  finishedAt: z.string().min(1),
});
export type UsageHistoryEntry = z.infer<typeof EntrySchema>;

const HistorySchema = z.object({ version: z.literal(1), builds: z.array(EntrySchema) });

/**
 * The measured builds that anchor a size with no finished build in the
 * project. Both are seat usage without the usage that engine defects
 * caused; see the "Usage watcher" section of the build pipeline design.
 */
const BUILT_IN: Readonly<Partial<Record<BuildSize, { tasks: number; tokensIn: number }>>> = {
  small: { tasks: 1, tokensIn: 2_000_000 },
  medium: { tasks: 10, tokensIn: 54_000_000 },
};

/** Serializes writes per table, so two builds that finish together both land. */
const writes = new Map<string, Promise<void>>();

function historyPath(projectRoot: string): string {
  return join(buildsDir(projectRoot), USAGE_HISTORY_FILE);
}

async function readHistory(projectRoot: string): Promise<UsageHistoryEntry[]> {
  const saved = await readJson(historyPath(projectRoot), HistorySchema);
  return saved?.builds ?? [];
}

type SettledEvent = Extract<AioEvent, { type: "lease.settled" }>;

/** The `lease.settled` events of build `buildId` in an `events.jsonl` file. */
async function settledEvents(file: string, buildId: string): Promise<SettledEvent[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: SettledEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"lease.settled"')) continue;
    let event: AioEvent;
    try {
      event = JSON.parse(line) as AioEvent;
    } catch {
      continue;
    }
    if (event.type === "lease.settled" && event.buildId === buildId) events.push(event);
  }
  return events;
}

/** The tokens in of the `lease.settled` events of build `buildId` in an `events.jsonl` file. */
async function settledTokensIn(file: string, buildId: string): Promise<number> {
  return (await settledEvents(file, buildId)).reduce((sum, e) => sum + e.tokens.in, 0);
}

/** The review runs that the build's review step started, from `review/run*.json`. */
async function reviewRunIds(ctx: BuildContext): Promise<string[]> {
  const dir = ctx.store.path("review");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids = new Set<string>();
  for (const name of names.filter((n) => /^run(-.+)?\.json$/.test(n))) {
    const record = await readJson<{ runId?: unknown }>(join(dir, name)).catch(() => undefined);
    if (typeof record?.runId === "string") ids.add(record.runId);
  }
  return [...ids];
}

/** The build's corrected usage: the tokens in of its settled calls and its review runs' calls. */
export async function correctedTokensIn(ctx: BuildContext): Promise<number> {
  const { id } = ctx.state;
  const { projectRoot } = ctx.store;
  let total = await settledTokensIn(ctx.store.path("events.jsonl"), id);
  for (const runId of await reviewRunIds(ctx)) {
    total += await settledTokensIn(join(projectRoot, RUNS_DIR, runId, "events.jsonl"), id);
  }
  return total;
}

/** One row of the usage by seat and step. */
export interface SeatStepUsage {
  seat: string;
  step: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

/** The seat name of a review run's own calls, such as its reviewers', which fill no build seat. */
export const REVIEW_RUN_SEAT = "(review run)";

/**
 * The usage of the build's settled agent calls and its review runs' calls,
 * by seat and step, sorted by seat and then step. A review run's own calls
 * count as the `(review run)` seat in the review step.
 */
export async function usageBySeatAndStep(ctx: BuildContext): Promise<SeatStepUsage[]> {
  const { id } = ctx.state;
  const { projectRoot } = ctx.store;
  const events = await settledEvents(ctx.store.path("events.jsonl"), id);
  for (const runId of await reviewRunIds(ctx)) {
    events.push(...(await settledEvents(join(projectRoot, RUNS_DIR, runId, "events.jsonl"), id)));
  }
  const rows = new Map<string, SeatStepUsage>();
  for (const event of events) {
    const seat = event.seat ?? REVIEW_RUN_SEAT;
    const step = event.step ?? (event.runId !== null ? "review" : "(no step)");
    const key = `${seat}\0${step}`;
    const row = rows.get(key) ?? { seat, step, calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    row.calls += 1;
    row.tokensIn += event.tokens.in;
    row.tokensOut += event.tokens.out;
    row.cost += event.costEstimate;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.seat.localeCompare(b.seat) || a.step.localeCompare(b.step),
  );
}

/** The usage by seat and step as a Markdown table with a total row. */
export function seatStepTable(rows: readonly SeatStepUsage[]): string[] {
  if (rows.length === 0) return ["No agent call settled."];
  const line = (r: SeatStepUsage) =>
    `| ${r.seat} | ${r.step} | ${r.calls} | ${r.tokensIn} | ${r.tokensOut} | ${r.cost.toFixed(2)} |`;
  const total = rows.reduce(
    (t, r) => ({
      ...t,
      calls: t.calls + r.calls,
      tokensIn: t.tokensIn + r.tokensIn,
      tokensOut: t.tokensOut + r.tokensOut,
      cost: t.cost + r.cost,
    }),
    { seat: "Total", step: "", calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 },
  );
  return [
    "| Seat | Step | Calls | Tokens in | Tokens out | Cost estimate (USD) |",
    "| :-- | :-- | --: | --: | --: | --: |",
    ...rows.map(line),
    line(total),
  ];
}

/** Adds a finished build's corrected usage to the table for its size, or replaces its entry. */
export async function recordFinishedBuild(ctx: BuildContext): Promise<UsageHistoryEntry> {
  const { projectRoot } = ctx.store;
  const entry: UsageHistoryEntry = {
    buildId: ctx.state.id,
    slug: ctx.state.slug,
    size: ctx.plan.size,
    tasks: ctx.plan.tasks.length,
    tokensIn: await correctedTokensIn(ctx),
    finishedAt: ctx.state.updatedAt,
  };
  const path = historyPath(projectRoot);
  const write = (writes.get(path) ?? Promise.resolve()).then(async () => {
    const builds = (await readHistory(projectRoot)).filter((b) => b.buildId !== entry.buildId);
    builds.push(entry);
    await writeJsonAtomic(path, { version: 1, builds });
  });
  writes.set(
    path,
    write.catch(() => undefined),
  );
  await write;
  return entry;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * The table as Markdown for the Analyst's prompt: for each size, the
 * project's finished builds, or the built-in measured build when the size
 * has none.
 */
export async function usageTableText(projectRoot: string): Promise<string> {
  const history = await readHistory(projectRoot);
  const rows = BuildSizeSchema.options.map((size) => {
    const own = history.filter((b) => b.size === size);
    const builtIn = BUILT_IN[size];
    const builds = own.length > 0 ? own : builtIn ? [builtIn] : [];
    if (builds.length === 0) {
      return `| ${size} | 0 | none | none | none | none | none | no build measured yet |`;
    }
    const totals = builds.map((b) => b.tokensIn);
    const perTask = builds.map((b) => b.tokensIn / b.tasks);
    const tasks = builds.map((b) => b.tasks);
    const source = own.length > 0 ? "this project's finished builds" : "built-in measured build";
    return `| ${size} | ${builds.length} | ${count(median(tasks))} | ${count(Math.min(...totals))} | ${count(median(totals))} | ${count(Math.max(...totals))} | ${count(Math.round(median(perTask)))} | ${source} |`;
  });
  return [
    "Measured builds, by size, for the usage estimate. Each figure is the tokens in that a finished build's seats spent, including planning and the review run, with each resumed session counted once and without the Project manager's session. A size with no finished build in this project shows a built-in measured build instead.",
    "",
    "| Size | Builds | Median tasks | Tokens in, lowest | Tokens in, median | Tokens in, highest | Median tokens in per task | Source |",
    "| :-- | --: | --: | --: | --: | --: | --: | :-- |",
    ...rows,
  ].join("\n");
}
