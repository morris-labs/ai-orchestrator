// Reduces a project's finished runs to the token figures that estimates use.
//
// Each finished run keeps its figures in `token-sample.json` in its run
// folder. The engine writes the file when the run finishes, or the first time
// it reads an older run. The server reads these files across projects, so a
// project with few runs can learn from the others; see docs/architecture.md.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  RunTokenSampleSchema,
  TOKEN_SAMPLE_FILE,
  TOKEN_SAMPLE_POINT_LIMIT,
  runDepth,
  weightedTokens,
  type ModelTier,
  type RunTokenSample,
  type VendorUsageSample,
  type WindowRate,
  type Vendor,
} from "@aio/contracts";
import { writeJsonAtomic } from "./files.js";
import { listRunIds, runsDir } from "./store.js";

/**
 * The version of the window logic in `measureUsage()`. A stored sample with
 * another version is measured again. Raise it whenever the logic changes.
 */
const USAGE_VERSION = 2;

/** The newest runs to read, so that a long history can't slow a preview. */
const RUNS_READ = 30;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

interface StoredCall {
  vendor?: Vendor;
  tokens?: { in?: number; out?: number; fresh?: number; cacheWrite?: number; cacheRead?: number };
  tier?: { tier?: ModelTier };
}

interface StoredState {
  status?: string;
  request?: Parameters<typeof runDepth>[0] & {
    scope?: string;
    reviewerEffort?: string;
    readOnly?: boolean;
  };
}

interface StoredGroup {
  id?: string;
  changedLines?: number;
  files?: unknown[];
}

/** Adds up a finished run's calls. Returns `null` for any other run, or one with no calls. */
async function measure(runId: string, dir: string): Promise<RunTokenSample | null> {
  const state = (await readJson(join(dir, "state.json"))) as StoredState | null;
  if (state?.status !== "finished" || !state.request) return null;
  const stored = await readJson(join(dir, "rounds", "1", "groups.json"));
  const firstGroups = (Array.isArray(stored) ? stored : []) as StoredGroup[];
  const linesOf = new Map<string, number>();
  for (const g of firstGroups) {
    if (typeof g?.id === "string") linesOf.set(g.id, Math.max(0, Number(g.changedLines) || 0));
  }
  const review = new Map<
    string,
    { vendor: Vendor; tier: ModelTier | null; tokens: number; groups: Map<string, number> }
  >();
  let verificationTokens = 0;
  const verificationStages = { disprove: 0, confirm: 0, sweep: 0 };
  let fixingTokens = 0;
  let calls = 0;
  const kinds = new Map<Vendor, Kinds>();
  for (const round of await listDir(join(dir, "rounds"))) {
    const callsDir = join(dir, "rounds", round, "calls");
    for (const name of await listDir(callsDir)) {
      const call = (await readJson(join(callsDir, name))) as StoredCall | null;
      if (!call?.tokens) continue;
      calls += 1;
      const tokens = Math.max(0, (call.tokens.in ?? 0) + (call.tokens.out ?? 0));
      if (call.vendor) addKinds(kinds, call.vendor, call.tokens);
      const group = /^find-(G\d+)/.exec(name)?.[1];
      if (group && call.vendor) {
        const tier = call.tier?.tier ?? null;
        const key = `${call.vendor}/${tier}`;
        const entry = review.get(key) ?? {
          vendor: call.vendor,
          tier,
          tokens: 0,
          groups: new Map<string, number>(),
        };
        entry.tokens += tokens;
        entry.groups.set(group, (entry.groups.get(group) ?? 0) + tokens);
        review.set(key, entry);
      } else if (name.startsWith("fix")) {
        fixingTokens += tokens;
      } else if (/^(verify|sweep|confirm)/.test(name)) {
        verificationTokens += tokens;
        const stage = name.startsWith("verify")
          ? "disprove"
          : name.startsWith("confirm")
            ? "confirm"
            : "sweep";
        verificationStages[stage] += tokens;
      }
    }
  }
  if (calls === 0) return null;
  const usage = await measureUsage(dir, kinds);
  return {
    runId,
    depth: runDepth(state.request),
    scope: state.request.scope === "whole" ? "whole" : "range",
    effort: state.request.reviewerEffort ?? "default",
    readOnly: state.request.readOnly ?? false,
    groups: firstGroups.length,
    lines: [...linesOf.values()].reduce((n, l) => n + l, 0),
    files: firstGroups.reduce((n, g) => n + (Array.isArray(g?.files) ? g.files.length : 0), 0),
    review: [...review.values()].map((r) => {
      // A group from a later round has no size in round 1, so it has no point.
      const points = [...r.groups]
        .filter(([id]) => linesOf.has(id))
        .map(([id, tokens]): [number, number] => [linesOf.get(id) ?? 0, tokens])
        .slice(0, TOKEN_SAMPLE_POINT_LIMIT);
      return {
        vendor: r.vendor,
        tier: r.tier,
        tokens: r.tokens,
        groups: r.groups.size,
        lines: [...r.groups.keys()].reduce((n, id) => n + (linesOf.get(id) ?? 0), 0),
        points,
      };
    }),
    verificationTokens,
    verificationStages,
    fixingTokens,
    // Empty rather than absent, which marks a sample saved before usage
    // windows existed.
    usage,
    usageVersion: USAGE_VERSION,
  };
}

type StoredTokens = NonNullable<StoredCall["tokens"]>;

/** Tokens by kind for the calls that reported a breakdown, and all of their tokens. */
interface Kinds {
  fresh: number;
  cacheWrite: number;
  cacheRead: number;
  out: number;
  raw: number;
}

/** Whether a call's tokens carry the breakdown by kind. */
function hasBreakdown(tokens: StoredTokens): boolean {
  return (
    tokens.fresh !== undefined || tokens.cacheWrite !== undefined || tokens.cacheRead !== undefined
  );
}

function kindsOf(tokens: StoredTokens): Kinds {
  return {
    fresh: Math.max(0, tokens.fresh ?? 0),
    cacheWrite: Math.max(0, tokens.cacheWrite ?? 0),
    cacheRead: Math.max(0, tokens.cacheRead ?? 0),
    out: Math.max(0, tokens.out ?? 0),
    raw: Math.max(0, (tokens.in ?? 0) + (tokens.out ?? 0)),
  };
}

function addKinds(totals: Map<Vendor, Kinds>, vendor: Vendor, tokens: StoredTokens): void {
  if (!hasBreakdown(tokens)) return;
  const add = kindsOf(tokens);
  const was = totals.get(vendor) ?? { fresh: 0, cacheWrite: 0, cacheRead: 0, out: 0, raw: 0 };
  totals.set(vendor, {
    fresh: was.fresh + add.fresh,
    cacheWrite: was.cacheWrite + add.cacheWrite,
    cacheRead: was.cacheRead + add.cacheRead,
    out: was.out + add.out,
    raw: was.raw + add.raw,
  });
}

/** Two reset times this close apart name the same window; some vendors round them. */
const SAME_RESET_MS = 5 * 60_000;

/**
 * Where readings that count come from. An `estimate` or `codex_tokens`
 * reading derives the share from token counts, so a rate from it would
 * echo the estimator's own assumption.
 */
const MEASURED_SOURCES: ReadonlySet<unknown> = new Set(["rate_limit_event", "codex_session"]);

/** One agent call, in `events.jsonl` order. */
interface Call {
  vendor: Vendor;
  /** The line of the call's `agent.started` event, or of its `agent.finished` event without one. */
  startSeq: number;
  endSeq: number;
  /** The times of the same events, in milliseconds. */
  startTime: number;
  endTime: number;
  weighted: number;
  /** Whether the call ended with an outcome other than `ok`. */
  failed: boolean;
  /**
   * Whether the call's tokens are unknown: a failed call reports zero tokens
   * with no breakdown, whatever it spent.
   */
  unknown: boolean;
  /** The accounts the call's readings named. */
  accounts: Set<string>;
}

interface RawReading {
  vendor: Vendor;
  window: WindowRate["window"];
  account: string;
  utilization: number;
  resetAt: number | null;
  time: number;
  seq: number;
  /** The call that took the reading, or `undefined` when unknown. */
  call: Call | undefined;
  /** Whether the vendor takes the reading as the call starts, before most of its tokens. */
  early: boolean;
}

/**
 * Readings of an older run that name no call, in a row with no lifecycle
 * event of their vendor between them, and the calls that could own them.
 */
interface UnnamedBlock {
  readings: RawReading[];
  /** Successful calls that finished before the block, with no reading since. */
  ok: Call[];
  /** Calls that were running when the block came; one that fails can own it. */
  running: Call[];
  /** A failed call with no `agent.started` event whose `agent.finished` came next. */
  untracked: Call | undefined;
}

interface Reading {
  /** The account's weighted tokens so far in the run when the reading came. */
  weighted: number;
  /** The `events.jsonl` line that `weighted` counts up to. */
  at: number;
  utilization: number;
  resetAt: number | null;
  /** When the reading was taken, in milliseconds. */
  time: number;
}

function sameWindow(a: Reading, b: Reading): boolean {
  if (a.resetAt === null || b.resetAt === null) return a.resetAt === b.resetAt;
  return Math.abs(a.resetAt - b.resetAt) < SAME_RESET_MS;
}

/** An event's time in milliseconds, or `NaN` when it has none. */
function timeOf(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

/**
 * Measures how each vendor's calls moved its usage windows, from the run's
 * `events.jsonl`: each `agent.finished` event gives a call's weighted
 * tokens, and each `usage.sample` event reads a window. Between two readings
 * of the same window, the rise in utilization goes with the tokens of the
 * account's calls in between. A stretch over a window reset doesn't count,
 * since the share used before the reset is unknown, and neither does a
 * stretch over a failed call that could be the account's, since its tokens
 * are unknown. Other use of the same account in that time counts as the
 * run's, so the rate errs high.
 *
 * A reading counts the tokens of the calls that finished before it was
 * taken: a Claude `rate_limit_event` comes as its call starts, and a Codex
 * reading as its call ends. Its time is that of the same event. Calls run at
 * once, so readings can arrive out of order; utilization within one window
 * only rises, so a reading lower than an earlier one adds nothing, and a
 * reading of an earlier window that falls after a reading of a later one is
 * left out. A call belongs to the account its readings name; a call without
 * readings belongs to the vendor's account when the run used only one, and
 * otherwise to none, which keeps the rate erring high. Only readings the
 * vendor reported count, not ones estimated from tokens.
 *
 * A vendor gets windows only when every one of its calls reported a
 * breakdown, since the weighted tokens would otherwise come up short. The
 * tokens by kind come from the same `agent.finished` events, so they cover
 * every call the windows do, call files or not; a run without those events
 * keeps the totals from its call files, `fileKinds`.
 */
async function measureUsage(
  dir: string,
  fileKinds: Map<Vendor, Kinds>,
): Promise<VendorUsageSample[]> {
  let text: string;
  try {
    text = await readFile(join(dir, "events.jsonl"), "utf8");
  } catch {
    text = "";
  }
  const eventKinds = new Map<Vendor, Kinds>();
  const partial = new Set<Vendor>();
  const calls = new Map<string, Call>();
  const finished: Call[] = [];
  const raw: RawReading[] = [];
  const accountsOf = new Map<Vendor, Set<string>>();
  // An older run's readings don't name their call. A successful call's
  // readings follow its `agent.finished` event, and a failed call's come
  // before it, so a block of them can belong to a successful call that
  // finished before it or to a call running then that fails. Calls run at
  // once, so a block with more than one such call is left out rather than
  // given to the wrong one.
  const blocks: UnnamedBlock[] = [];
  const open = new Map<Vendor, UnnamedBlock>();
  const pendingOk = new Map<Vendor, Call[]>();
  const running = new Map<Vendor, Set<Call>>();
  let seq = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    seq += 1;
    const vendor = event.vendor as Vendor | undefined;
    if (vendor !== "claude" && vendor !== "codex" && vendor !== "copilot") continue;
    const agentId = typeof event.agentId === "string" ? event.agentId : null;
    if (event.type === "agent.started" || event.type === "agent.finished") {
      const block = open.get(vendor);
      open.delete(vendor);
      const vendorRunning = running.get(vendor) ?? new Set<Call>();
      running.set(vendor, vendorRunning);
      if (event.type === "agent.started") {
        if (agentId) {
          const call: Call = {
            vendor,
            startSeq: seq,
            endSeq: Infinity,
            startTime: timeOf(event.time),
            endTime: NaN,
            weighted: 0,
            failed: false,
            unknown: false,
            accounts: new Set(),
          };
          calls.set(agentId, call);
          vendorRunning.add(call);
        }
        continue;
      }
      const started = agentId ? calls.get(agentId) : undefined;
      const call = started ?? {
        vendor,
        startSeq: seq,
        endSeq: seq,
        startTime: timeOf(event.time),
        endTime: NaN,
        weighted: 0,
        failed: false,
        unknown: false,
        accounts: new Set<string>(),
      };
      call.endSeq = seq;
      call.endTime = timeOf(event.time);
      call.failed = event.outcome !== undefined && event.outcome !== "ok";
      if (agentId) calls.set(agentId, call);
      if (started) vendorRunning.delete(started);
      if (call.failed && !started && block) block.untracked = call;
      if (!call.failed) pendingOk.set(vendor, [...(pendingOk.get(vendor) ?? []), call]);
      finished.push(call);
      const tokens = event.tokens as StoredTokens | undefined;
      if (!tokens || !hasBreakdown(tokens)) {
        if (tokens && (tokens.in ?? 0) + (tokens.out ?? 0) > 0) partial.add(vendor);
        // A failed call reports no tokens, but it can still have spent some.
        else call.unknown = call.failed;
        continue;
      }
      call.weighted = weightedTokens(vendor, kindsOf(tokens));
      addKinds(eventKinds, vendor, tokens);
    } else if (event.type === "usage.sample") {
      const window = event.window as WindowRate["window"];
      if (window !== "5h" && window !== "7d" && window !== "month") continue;
      if (typeof event.utilization !== "number" || event.spendUsd !== null) continue;
      if (!MEASURED_SOURCES.has(event.sampleSource)) continue;
      const account = typeof event.account === "string" ? event.account : "";
      const accounts = accountsOf.get(vendor) ?? new Set<string>();
      accounts.add(account);
      accountsOf.set(vendor, accounts);
      const resetAt = typeof event.resetAt === "string" ? Date.parse(event.resetAt) : NaN;
      const reading: RawReading = {
        vendor,
        window,
        account,
        utilization: event.utilization,
        resetAt: Number.isFinite(resetAt) ? resetAt : null,
        time: Number.isFinite(timeOf(event.time)) ? timeOf(event.time) : 0,
        seq,
        call: undefined,
        early: event.sampleSource === "rate_limit_event",
      };
      if (agentId) {
        reading.call = calls.get(agentId);
        reading.call?.accounts.add(account);
        raw.push(reading);
        continue;
      }
      let block = open.get(vendor);
      if (!block) {
        block = {
          readings: [],
          ok: pendingOk.get(vendor) ?? [],
          running: [...(running.get(vendor) ?? [])],
          untracked: undefined,
        };
        pendingOk.set(vendor, []);
        open.set(vendor, block);
        blocks.push(block);
      }
      block.readings.push(reading);
    }
  }
  for (const block of blocks) {
    const owners = new Set([
      ...block.ok,
      ...block.running.filter((c) => c.failed),
      ...(block.untracked ? [block.untracked] : []),
    ]);
    if (owners.size !== 1) continue;
    const [owner] = owners;
    for (const r of block.readings) {
      r.call = owner;
      owner?.accounts.add(r.account);
      raw.push(r);
    }
  }
  const belongs = (call: Call, account: string): boolean => {
    if (call.accounts.size > 0) return call.accounts.has(account);
    return (accountsOf.get(call.vendor)?.size ?? 0) === 1;
  };
  // The weighted tokens of `account`'s calls that finished by line `at`.
  const weightedBy = (vendor: Vendor, account: string, at: number): number =>
    finished
      .filter((c) => c.vendor === vendor && c.endSeq <= at && belongs(c, account))
      .reduce((n, c) => n + c.weighted, 0);
  // Whether a failed call that could be `account`'s finished between two lines.
  const unknownBetween = (vendor: Vendor, account: string, a: number, b: number): boolean =>
    finished.some(
      (c) =>
        c.vendor === vendor &&
        c.unknown &&
        c.endSeq > Math.min(a, b) &&
        c.endSeq <= Math.max(a, b) &&
        (c.accounts.size === 0 || c.accounts.has(account)),
    );
  // Keyed by vendor, then window, then account.
  const readings = new Map<Vendor, Map<WindowRate["window"], Map<string, Reading[]>>>();
  for (const r of raw) {
    const at = r.call ? (r.early ? r.call.startSeq : r.call.endSeq) : r.seq;
    // The event's own time is when the engine wrote it, which for a reading
    // taken as its call starts comes only after the call ends.
    const callTime = r.call ? (r.early ? r.call.startTime : r.call.endTime) : NaN;
    const time = Number.isFinite(callTime) ? callTime : r.time;
    const byWindow = readings.get(r.vendor) ?? new Map();
    const byAccount = byWindow.get(r.window) ?? new Map<string, Reading[]>();
    const list = byAccount.get(r.account) ?? [];
    list.push({
      weighted: weightedBy(r.vendor, r.account, at),
      at,
      utilization: r.utilization,
      resetAt: r.resetAt,
      time,
    });
    byAccount.set(r.account, list);
    byWindow.set(r.window, byAccount);
    readings.set(r.vendor, byWindow);
  }
  const kinds = new Map(fileKinds);
  for (const [vendor, k] of eventKinds) kinds.set(vendor, k);
  const out: VendorUsageSample[] = [];
  for (const [vendor, k] of kinds) {
    const windows: WindowRate[] = [];
    const byWindow = partial.has(vendor) ? undefined : readings.get(vendor);
    for (const [window, byAccount] of byWindow ?? []) {
      const [account, readingsOf] = [...byAccount].sort((a, b) => b[1].length - a[1].length)[0] ?? [
        "",
        [],
      ];
      const order = (a: Reading, b: Reading) => a.weighted - b.weighted || a.time - b.time;
      // One list per window, oldest window first.
      const periods: Reading[][] = [];
      for (const r of readingsOf
        .slice()
        .sort((a, b) => (a.resetAt ?? -Infinity) - (b.resetAt ?? -Infinity) || order(a, b))) {
        const last = periods[periods.length - 1];
        if (last?.[0] && sameWindow(last[0], r)) last.push(r);
        else periods.push([r]);
      }
      let used = 0;
      let tokens = 0;
      let durationMs = 0;
      let stretches = 0;
      periods.forEach((period, p) => {
        // A reading of this window after a later window's first reading came
        // late, so its tokens would overlap that window's.
        const later = periods.slice(p + 1).flat();
        const limit = later.length ? Math.min(...later.map((r) => r.weighted)) : Infinity;
        const list = period.filter((r) => r.weighted <= limit).sort(order);
        let peak = list[0]?.utilization ?? 0;
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1] as Reading;
          const b = list[i] as Reading;
          if (unknownBetween(vendor, account, a.at, b.at)) {
            peak = Math.max(peak, b.utilization);
            continue;
          }
          stretches += 1;
          used += Math.max(0, b.utilization - peak);
          peak = Math.max(peak, b.utilization);
          tokens += b.weighted - a.weighted;
          durationMs += Math.max(0, b.time - a.time);
        }
      });
      if (stretches === 0 || tokens <= 0) continue;
      windows.push({
        window,
        used,
        weighted: Math.round(tokens),
        rate: used / tokens,
        durationMs,
        resets: periods.length - 1,
        ...(account ? { account: accountKey(vendor, account) } : {}),
      });
    }
    out.push({
      vendor,
      fresh: k.fresh,
      cacheWrite: k.cacheWrite,
      cacheRead: k.cacheRead,
      out: k.out,
      raw: k.raw,
      windows,
    });
  }
  return out;
}

/**
 * An opaque key for a vendor's account label, so a sample can tell accounts
 * apart without holding a name or an email.
 */
function accountKey(vendor: Vendor, account: string): string {
  return createHash("sha256").update(`${vendor}\0${account}`).digest("hex").slice(0, 16);
}

/**
 * Measures a finished run and stores its sample in the run folder. Returns the
 * sample, or `null` for a run that isn't finished or has no calls.
 */
export async function saveTokenSample(
  projectRoot: string,
  runId: string,
): Promise<RunTokenSample | null> {
  const dir = join(runsDir(projectRoot), runId);
  const sample = await measure(runId, dir);
  if (sample) await writeJsonAtomic(join(dir, TOKEN_SAMPLE_FILE), sample);
  return sample;
}

/**
 * Samples measured again but not stored, by run folder, so that a folder that
 * can't be written isn't measured on every preview. A finished run doesn't
 * change.
 */
const unsaved = new Map<string, RunTokenSample>();

async function sampleOf(projectRoot: string, runId: string): Promise<RunTokenSample | null> {
  const dir = join(runsDir(projectRoot), runId);
  const kept = unsaved.get(dir);
  if (kept) return kept;
  const stored = RunTokenSampleSchema.safeParse(await readJson(join(dir, TOKEN_SAMPLE_FILE)));
  const current = stored.success && stored.data.runId === runId ? stored.data : null;
  // A sample saved before usage windows or the verification split existed
  // lacks `usage` or `verificationStages`, and one whose windows came from
  // older logic has another `usageVersion`, so the run is measured again,
  // since its calls and events can still give them.
  if (
    current?.usage !== undefined &&
    current.usageVersion === USAGE_VERSION &&
    current.verificationStages !== undefined
  ) {
    return current;
  }
  // An older run has no sample file yet. Writing it can fail on a read-only
  // folder, and the measured sample still counts. A run whose calls are gone
  // keeps its stored sample.
  const sample = await measure(runId, dir);
  const saved = sample
    ? await writeJsonAtomic(join(dir, TOKEN_SAMPLE_FILE), sample).then(
        () => true,
        () => false,
      )
    : false;
  const result = sample ?? current;
  if (result && !saved) unsaved.set(dir, result);
  return result;
}

/** This project's finished runs with stored calls, oldest first. A damaged run is skipped. */
export async function loadTokenHistory(projectRoot: string): Promise<RunTokenSample[]> {
  const ids = (await listRunIds(projectRoot)).slice(-RUNS_READ);
  const samples = await Promise.all(ids.map((id) => sampleOf(projectRoot, id)));
  return samples.filter((s): s is RunTokenSample => s !== null);
}
