// The Project manager hand-off: at each milestone end, after the
// milestone's digest, code writes a hand-off file from the build's files
// and the Project manager gets a pointer that tells it to start a fresh
// session from it. The hand-off holds what a fresh session needs to go on
// without rereading earlier turns: the plan state, the open escalations,
// the owner's decisions, the defaulted answers, and the usage to date. The
// Project manager's per-request context then stays the size of one
// milestone, not of the whole build.
import { PM_SEAT, type BuildMilestone } from "@aio/contracts";
import type { BuildContext } from "./context.js";
import { oneLine } from "./inbox.js";
import { planningStart, projectManagerUsage, type TranscriptUsage } from "./pm-usage.js";
import { digestFile, usageSince, usageTable } from "./digests.js";

/** A milestone's hand-off file, relative to the build directory. */
export function handoffFile(milestoneId: string): string {
  return `handoffs/milestone-${milestoneId}.md`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What comes next: the first milestone that isn't done, or the release steps, with its verb. */
function nextOf(
  ctx: BuildContext,
  milestones: readonly BuildMilestone[],
): { what: string; clause: string } {
  const next = milestones.find((m) => m.tasks.some((id) => ctx.task(id).status !== "done"));
  if (!next)
    return {
      what: "the review and release steps",
      clause: "the review and release steps are next",
    };
  const what = `milestone ${next.id} (${next.title})`;
  return { what, clause: `${what} is next` };
}

function planState(ctx: BuildContext, milestones: readonly BuildMilestone[]): string[] {
  const milestoneOf = new Map(milestones.flatMap((m) => m.tasks.map((id) => [id, m.id])));
  return [
    `The build is ${ctx.state.status} at the ${ctx.state.step} step, on plan version ${ctx.plan.version}: ${ctx.store.path("plan.json")}.`,
    "",
    "Milestones:",
    "",
    ...milestones.map((m) => {
      const done = m.tasks.filter((id) => ctx.task(id).status === "done").length;
      return done === m.tasks.length
        ? `- ${m.id} ${m.title}: done.`
        : `- ${m.id} ${m.title}: ${done} of ${plural(m.tasks.length, "task")} done.`;
    }),
    "",
    "Tasks:",
    "",
    ...ctx.plan.tasks.map((task) => {
      const progress = ctx.task(task.id);
      const commit = progress.commit ? `, commit \`${progress.commit.slice(0, 12)}\`` : "";
      return `- ${task.id} ${task.title} (${milestoneOf.get(task.id) ?? "no milestone"}): ${progress.status} in ${plural(progress.attempts, "attempt")}${commit}.`;
    }),
  ];
}

function openEscalations(ctx: BuildContext): string[] {
  const open = ctx.state.escalations.filter((e) => e.status !== "resolved");
  if (open.length === 0) return ["None."];
  return open.map((e) => {
    const pauses = e.tasks.length > 0 ? e.tasks.join(", ") : "the build";
    return `- ${e.id} (${e.kind}, for the ${e.level.replace("_", " ")}): ${oneLine(e.summary)} It pauses ${pauses}. Read ${ctx.store.path(e.file)}`;
  });
}

async function ownerDecisions(ctx: BuildContext): Promise<string[]> {
  const push =
    ctx.plan.push === null
      ? "Push answer: not asked yet."
      : `Push answer: ${ctx.plan.push ? "yes" : "no"}.`;
  const answers = ctx.state.escalations
    .filter((e) => e.resolution?.by === "owner")
    .map((e) => {
      const r = e.resolution!;
      const note = r.note ? `: "${oneLine(r.note)}"` : "";
      const changes = r.changes.length > 0 ? ` It changes the plan's ${r.changes.join(", ")}.` : "";
      return `- ${e.id}: the owner answered with ${r.action}${note}.${changes}`;
    });
  const posts = (await ctx.decisions.list()).map((d) => {
    const about = d.taskId ?? d.milestone ?? "the build";
    const flag = d.planChange ? ` It contradicts ${d.planChange.criteria.join(", ")}.` : "";
    return `- ${d.id}, an owner post about ${about}: "${oneLine(d.body)}"${flag} Read ${ctx.store.path(`decisions/${d.id}.json`)}`;
  });
  return [
    push,
    "",
    ...(answers.length + posts.length === 0
      ? ["The owner answered no escalation and posted no decision."]
      : [...answers, ...posts]),
  ];
}

function defaultedAnswers(ctx: BuildContext): string[] {
  const answers = ctx.plan.defaultedAnswers ?? [];
  if (answers.length === 0) return ["None."];
  return answers.map((a) => `- ${a.question} Defaulted to: ${a.answer}`);
}

async function usageToDate(ctx: BuildContext): Promise<string[]> {
  const since = await planningStart(ctx);
  const pm: TranscriptUsage | null = await projectManagerUsage(ctx, { since }).catch(() => null);
  return [
    `What the build's settled agent calls spent since the build started, by seat.${pm && pm.turns > 0 ? ` The ${PM_SEAT} row is what the Project manager's own sessions spent since ${since}: tokens only.` : ""}`,
    "",
    ...usageTable(await usageSince(ctx, ""), pm, "No agent call settled yet."),
  ];
}

/** Renders the hand-off after `milestone`. */
async function renderHandoff(
  ctx: BuildContext,
  milestone: BuildMilestone,
  milestones: readonly BuildMilestone[],
): Promise<string> {
  return [
    `# Hand-off after milestone ${milestone.id} of build ${ctx.state.slug}: ${milestone.title}`,
    "",
    "Start a fresh Project manager session from this file. It holds what you need to go on, so don't reread earlier turns, diffs, or full logs. For what changed since, run `aio-build inbox " +
      ctx.state.slug +
      "` and read the files it lists.",
    "",
    `Next: ${nextOf(ctx, milestones).what}.`,
    "",
    `The milestone's digest: ${ctx.store.path(digestFile(milestone.id))}`,
    "",
    "## Plan state",
    "",
    ...planState(ctx, milestones),
    "",
    "## Open escalations",
    "",
    ...openEscalations(ctx),
    "",
    "## Owner decisions",
    "",
    ...(await ownerDecisions(ctx)),
    "",
    "## Defaulted answers",
    "",
    ...defaultedAnswers(ctx),
    "",
    "## Usage to date",
    "",
    ...(await usageToDate(ctx)),
    "",
  ].join("\n");
}

/**
 * Writes the hand-off after `milestone` and adds its pointer to the
 * Project manager's inbox. Call it after the milestone's digest, so the
 * pointer comes second.
 */
export async function handOff(
  ctx: BuildContext,
  milestone: BuildMilestone,
  milestones: readonly BuildMilestone[],
): Promise<void> {
  const file = handoffFile(milestone.id);
  await ctx.store.writeText(ctx.store.path(file), await renderHandoff(ctx, milestone, milestones));
  await ctx.toProjectManager({
    kind: "handoff",
    ref: `milestone-${milestone.id}`,
    summary: `Start a fresh Project manager session from this hand-off file: milestone ${milestone.id} (${milestone.title}) is done, and ${nextOf(ctx, milestones).clause}.`,
    file,
    needsAnswer: false,
  });
}
