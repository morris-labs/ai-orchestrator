// Reduces a project's finished runs to the token figures that estimates use.
//
// Each finished run keeps its figures in `token-sample.json` in its run
// folder. The engine writes the file when the run finishes, or the first time
// it reads an older run. The server reads these files across projects, so a
// project with few runs can learn from the others; see docs/architecture.md.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  RunTokenSampleSchema,
  TOKEN_SAMPLE_FILE,
  TOKEN_SAMPLE_POINT_LIMIT,
  runDepth,
  type ModelTier,
  type RunTokenSample,
  type Vendor,
} from "@aio/contracts";
import { writeJsonAtomic } from "./files.js";
import { listRunIds, runsDir } from "./store.js";

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
  tokens?: { in?: number; out?: number };
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
  let fixingTokens = 0;
  let calls = 0;
  for (const round of await listDir(join(dir, "rounds"))) {
    const callsDir = join(dir, "rounds", round, "calls");
    for (const name of await listDir(callsDir)) {
      const call = (await readJson(join(callsDir, name))) as StoredCall | null;
      if (!call?.tokens) continue;
      calls += 1;
      const tokens = Math.max(0, (call.tokens.in ?? 0) + (call.tokens.out ?? 0));
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
      }
    }
  }
  if (calls === 0) return null;
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
    fixingTokens,
  };
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

async function sampleOf(projectRoot: string, runId: string): Promise<RunTokenSample | null> {
  const stored = RunTokenSampleSchema.safeParse(
    await readJson(join(runsDir(projectRoot), runId, TOKEN_SAMPLE_FILE)),
  );
  if (stored.success && stored.data.runId === runId) return stored.data;
  // An older run has no sample file yet. Writing it can fail on a read-only
  // folder, and the measured sample still counts.
  const dir = join(runsDir(projectRoot), runId);
  const sample = await measure(runId, dir);
  if (sample) await writeJsonAtomic(join(dir, TOKEN_SAMPLE_FILE), sample).catch(() => undefined);
  return sample;
}

/** This project's finished runs with stored calls, oldest first. A damaged run is skipped. */
export async function loadTokenHistory(projectRoot: string): Promise<RunTokenSample[]> {
  const ids = (await listRunIds(projectRoot)).slice(-RUNS_READ);
  const samples = await Promise.all(ids.map((id) => sampleOf(projectRoot, id)));
  return samples.filter((s): s is RunTokenSample => s !== null);
}
