// The checks a failed run must pass before `RunController.retry()` resumes it.
// They read only what is stored, so they also cover a run that an older engine
// failed.
import { VENDOR_ROLES, belowVerifyFloor, type Severity, type Stage } from "@aio/contracts";
import type { RunContext } from "./context.js";
import { reporterVendor } from "./steps.js";

/** The stages each driver can start from. `done` isn't one: nothing is left to resume. */
const RESUMABLE: Record<"pre-push" | "post-push", readonly Stage[]> = {
  "pre-push": ["preflight", "group", "find", "merge", "verify", "sweep", "fix", "gate", "confirm"],
  "post-push": ["preflight", "push", "poll", "import", "verify", "fix", "gate"],
};

/** Pre-push stages that need a round's opening files, and the merge's. */
const ROUND_STAGES: readonly Stage[] = ["merge", "verify", "sweep", "fix", "gate", "confirm"];
const AFTER_MERGE: readonly Stage[] = ["verify", "sweep", "fix", "gate", "confirm"];

const FINDING_NUMBER = /^F-(\d+)$/;

/** What keeps the run from resuming, one sentence each; empty when it can. */
export async function retryProblems(
  ctx: RunContext,
  floor: Severity | undefined,
  crossVendor: boolean = ctx.state.request.crossVendor,
): Promise<string[]> {
  const { state, eng, store, findings } = ctx;
  const problems: string[] = [];
  const stage = state.stage;
  if (!RESUMABLE[eng.phase].includes(stage)) {
    problems.push(`A ${eng.phase} run can't resume from the ${stage} stage.`);
    return problems;
  }
  for (const [name, sha] of [
    ["base", state.baseSha],
    ["tip", state.tipSha],
  ] as const) {
    if (!sha) problems.push(`The run has no ${name} commit.`);
    else if (!(await ctx.git.ok(["cat-file", "-e", `${sha}^{commit}`]))) {
      problems.push(`The ${name} commit ${sha} isn't in ${state.request.repoPath}.`);
    }
  }
  if (eng.phase === "pre-push" && ROUND_STAGES.includes(stage)) {
    if (state.round < 1 || !eng.roundOpen) {
      problems.push(`The ${stage} stage needs an open round, and the saved state has none.`);
    } else if (!(await store.loadGroups(state.round))) {
      problems.push(`Round ${state.round} has no saved file groups.`);
    } else if (
      AFTER_MERGE.includes(stage) &&
      !(await store.readJson(store.roundFile(state.round, "merge")))
    ) {
      problems.push(`Round ${state.round} has no saved merge result.`);
    }
  }
  for (const file of eng.appliedMerges) {
    if (!(await store.readJson(file))) problems.push(`The merge file ${file} is missing.`);
  }
  const ids = new Set<string>();
  let highest = 0;
  for (const f of findings) {
    if (ids.has(f.id)) problems.push(`The findings list ${f.id} twice.`);
    ids.add(f.id);
    highest = Math.max(highest, Number(FINDING_NUMBER.exec(f.id)?.[1] ?? 0));
  }
  if (highest > eng.counters.finding) {
    problems.push(
      `The finding counter ${eng.counters.finding} is behind the highest finding, ${highest}.`,
    );
  }
  if (crossVendor) {
    const stuck = findings.filter(
      (f) =>
        f.verdict === "pending" &&
        !belowVerifyFloor(f, floor) &&
        !ctx.availableVendors.some(
          (v) => v !== reporterVendor(f) && VENDOR_ROLES[v].includes("disprover"),
        ),
    );
    if (stuck.length > 0) {
      problems.push(
        `No available vendor other than the reporter can disprove ${stuck.length} pending findings, such as ${stuck[0]?.id}.`,
      );
    }
  }
  return problems;
}

/**
 * A notice when the branch moved since the run saved its tip. A retry treats
 * this like any resume: the open round keeps checking the saved commit, the
 * fix stage commits on the branch as it stands, and the next round reviews
 * the new tip.
 */
export async function tipMovedNotice(ctx: RunContext): Promise<string[]> {
  const { tipRef } = ctx.eng;
  const saved = ctx.state.tipSha;
  if (!tipRef || !saved || ctx.state.request.readOnly) return [];
  const now = await ctx.git.run(["rev-parse", "--verify", "-q", tipRef]).catch(() => "");
  const head = now.trim();
  if (head === "" || head === saved) return [];
  return [
    `${tipRef} moved from ${saved.slice(0, 12)} to ${head.slice(0, 12)} since the run saved its tip. This round keeps checking the saved commit, and the next round reviews the branch as it stands.`,
  ];
}
