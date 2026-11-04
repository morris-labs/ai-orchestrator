// Reduces a project's finished runs to the token figures that estimates use.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runDepth, type ModelTier, type RunTokenSample, type Vendor } from "@aio/contracts";
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

async function sampleOf(runId: string, dir: string): Promise<RunTokenSample | null> {
  const state = (await readJson(join(dir, "state.json"))) as StoredState | null;
  if (state?.status !== "finished" || !state.request) return null;
  const rounds = await listDir(join(dir, "rounds"));
  const review = new Map<
    string,
    { vendor: Vendor; tier: ModelTier | null; tokens: number; groups: Set<string> }
  >();
  let verificationTokens = 0;
  let fixingTokens = 0;
  let calls = 0;
  for (const round of rounds) {
    const callsDir = join(dir, "rounds", round, "calls");
    for (const name of await listDir(callsDir)) {
      const call = (await readJson(join(callsDir, name))) as StoredCall | null;
      if (!call?.tokens) continue;
      calls += 1;
      const tokens = (call.tokens.in ?? 0) + (call.tokens.out ?? 0);
      const group = /^find-(G\d+)/.exec(name)?.[1];
      if (group && call.vendor) {
        const tier = call.tier?.tier ?? null;
        const key = `${call.vendor}/${tier}`;
        const entry = review.get(key) ?? {
          vendor: call.vendor,
          tier,
          tokens: 0,
          groups: new Set(),
        };
        entry.tokens += tokens;
        entry.groups.add(group);
        review.set(key, entry);
      } else if (name.startsWith("fix")) {
        fixingTokens += tokens;
      } else if (/^(verify|sweep|confirm)/.test(name)) {
        verificationTokens += tokens;
      }
    }
  }
  if (calls === 0) return null;
  const firstGroups = await readJson(join(dir, "rounds", "1", "groups.json"));
  const groups = Array.isArray(firstGroups) ? firstGroups.length : 0;
  return {
    runId,
    depth: runDepth(state.request),
    scope: state.request.scope === "whole" ? "whole" : "range",
    effort: state.request.reviewerEffort ?? "default",
    readOnly: state.request.readOnly ?? false,
    groups,
    review: [...review.values()].map((r) => ({
      vendor: r.vendor,
      tier: r.tier,
      tokens: r.tokens,
      groups: r.groups.size,
    })),
    verificationTokens,
    fixingTokens,
  };
}

/** This project's finished runs with stored calls, oldest first. A damaged run is skipped. */
export async function loadTokenHistory(projectRoot: string): Promise<RunTokenSample[]> {
  const ids = (await listRunIds(projectRoot)).slice(-RUNS_READ);
  const samples = await Promise.all(ids.map((id) => sampleOf(id, join(runsDir(projectRoot), id))));
  return samples.filter((s): s is RunTokenSample => s !== null);
}
