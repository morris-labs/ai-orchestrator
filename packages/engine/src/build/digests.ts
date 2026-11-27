// Milestone digests: when every task of a milestone is done, code builds a
// digest from the build's files and the Project manager gets a pointer to
// it. A digest reports the milestone's tasks, the usage it spent by seat,
// its escalations, the owner posts flagged as plan changes, and how much
// team chat it took. The Project manager reads digests, not the raw
// messages.
//
// The engine runs the tasks of every milestone in one tasks step, so a
// milestone ends when its last task passes the task gate. Its usage is
// what the build's settled agent calls spent since the previous milestone's
// digest, or since the build started for the first one. The Project
// manager's session makes no engine calls, so its row comes from its
// transcripts (`pm-usage.ts`), from when planning started for the first
// milestone, and has tokens only. A plan without milestones has one, `all`,
// which holds every task.
import { readFile } from "node:fs/promises";
import type { AioEvent, BuildMilestone, Escalation, Message } from "@aio/contracts";
import { PM_SEAT, escalationState } from "@aio/contracts";
import type { BuildContext } from "./context.js";
import { handOff } from "./handoff.js";
import { decisionsFor } from "./owner/index.js";
import {
  planningStart,
  projectManagerUsage,
  reportProjectManagerUsage,
  type TranscriptUsage,
} from "./pm-usage.js";

/** A milestone digest's file, relative to the build directory. */
export function digestFile(milestoneId: string): string {
  return `digests/milestone-${milestoneId}.md`;
}

/** The milestones of the plan, or one milestone with every task when it names none. */
export function milestonesOf(ctx: BuildContext): BuildMilestone[] {
  if (ctx.plan.milestones.length > 0) return ctx.plan.milestones;
  return [
    {
      id: "all",
      title: ctx.plan.title,
      goal: "Every task of the build plan is done.",
      tasks: ctx.plan.tasks.map((t) => t.id),
    },
  ];
}

export interface SeatUsage {
  seat: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

/** The usage of the build's settled calls after `from`, by seat, sorted by seat. */
export async function usageSince(ctx: BuildContext, from: string): Promise<SeatUsage[]> {
  let text = "";
  try {
    text = await readFile(ctx.store.path("events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bySeat = new Map<string, SeatUsage>();
  for (const line of text.split("\n")) {
    if (!line.includes('"lease.settled"')) continue;
    let event: AioEvent;
    try {
      event = JSON.parse(line) as AioEvent;
    } catch {
      continue;
    }
    if (event.type !== "lease.settled" || event.buildId !== ctx.state.id) continue;
    if (event.time <= from) continue;
    const seat = event.seat ?? "(no seat)";
    const row = bySeat.get(seat) ?? { seat, calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    row.calls += 1;
    row.tokensIn += event.tokens.in;
    row.tokensOut += event.tokens.out;
    row.cost += event.costEstimate;
    bySeat.set(seat, row);
  }
  return [...bySeat.values()].sort((a, b) => a.seat.localeCompare(b.seat));
}

/** The usage by seat as a Markdown table, or `empty` and the Project manager's row for no calls. */
export function usageTable(
  rows: readonly SeatUsage[],
  pm: TranscriptUsage | null,
  empty = "No agent call settled in this milestone.",
): string[] {
  const pmLine =
    pm && pm.turns > 0
      ? [
          `| ${PM_SEAT} (tokens only) | ${pm.turns} turn${pm.turns === 1 ? "" : "s"} | ${pm.tokensIn} | ${pm.tokensOut} | n/a |`,
        ]
      : [];
  if (rows.length === 0) {
    return [
      empty,
      ...(pmLine.length > 0
        ? [
            "",
            "| Seat | Calls | Tokens in | Tokens out | Cost estimate (USD) |",
            "| :-- | --: | --: | --: | --: |",
            ...pmLine,
          ]
        : []),
    ];
  }
  const total = rows.reduce(
    (t, r) => ({
      seat: "Total",
      calls: t.calls + r.calls,
      tokensIn: t.tokensIn + r.tokensIn,
      tokensOut: t.tokensOut + r.tokensOut,
      cost: t.cost + r.cost,
    }),
    { seat: "Total", calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 },
  );
  const line = (r: SeatUsage) =>
    `| ${r.seat} | ${r.calls} | ${r.tokensIn} | ${r.tokensOut} | ${r.cost.toFixed(2)} |`;
  return [
    "| Seat | Calls | Tokens in | Tokens out | Cost estimate (USD) |",
    "| :-- | --: | --: | --: | --: |",
    ...rows.map(line),
    line(total),
    ...pmLine,
  ];
}

/** The digest of milestone `milestone`, number `done` of `count`. */
async function renderDigest(
  ctx: BuildContext,
  milestone: BuildMilestone,
  done: number,
  count: number,
  from: string,
  pm: (TranscriptUsage & { since: string }) | null,
): Promise<string> {
  const tasks = new Set(milestone.tasks);
  const taskLines = milestone.tasks.map((id) => {
    const task = ctx.plan.tasks.find((t) => t.id === id);
    const progress = ctx.task(id);
    const attempts = `${progress.attempts} attempt${progress.attempts === 1 ? "" : "s"}`;
    const commit = progress.commit ? `, commit \`${progress.commit.slice(0, 12)}\`` : "";
    return `- ${id} ${task?.title ?? ""}: ${progress.status} in ${attempts}${commit}.`;
  });
  const escalations = ctx.state.escalations.filter(
    (e: Escalation) =>
      (e.taskId !== null && tasks.has(e.taskId)) || (e.taskId === null && e.createdAt > from),
  );
  const flags = decisionsFor(await ctx.decisions.list(), milestone.tasks, ctx.plan).filter(
    (d) => d.planChange !== null,
  );
  const messages = ((await ctx.team?.list()) ?? []).filter(
    (m: Message) => (m.taskId !== null && tasks.has(m.taskId)) || m.milestone === milestone.id,
  );
  const byType = new Map<string, number>();
  for (const m of messages) byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
  return [
    `# Milestone ${milestone.id} of build ${ctx.state.slug}: ${milestone.title}`,
    "",
    `Goal: ${milestone.goal}`,
    "",
    `Every task of the milestone passed the task gate: ${done} of ${count} milestones are done.`,
    "",
    "## Tasks",
    "",
    ...taskLines,
    "",
    "## Usage",
    "",
    `What the build's settled agent calls spent since ${from}, by seat. The total covers those calls.${pm && pm.turns > 0 ? ` The ${PM_SEAT} row is what the Project manager's own session spent since ${pm.since}, read from its transcripts: tokens only, with no cost estimate.` : ""}`,
    "",
    ...usageTable(await usageSince(ctx, from), pm),
    "",
    "## Escalations",
    "",
    ...(escalations.length === 0
      ? ["None."]
      : escalations.map((e) => `- ${e.id} (${e.kind}): ${e.summary} ${escalationState(e)}.`)),
    "",
    "## Plan change flags",
    "",
    ...(flags.length === 0
      ? ["None."]
      : flags.map(
          (d) =>
            `- ${d.id}: owner post ${d.messageId} contradicts ${d.planChange?.criteria.join(", ")}. ${d.planChange?.reason ?? ""} Change the plan's criteria to match it, or ask the owner.`,
        )),
    "",
    "## Team chat",
    "",
    messages.length === 0
      ? "No messages."
      : `${messages.length} message${messages.length === 1 ? "" : "s"}: ${[...byType]
          .map(([type, n]) => `${n} ${type}`)
          .join(", ")}. Read them with \`aio-build messages ${ctx.state.slug}\`.`,
    "",
  ].join("\n");
}

/**
 * Writes a digest for each milestone whose tasks are all done and that has
 * no digest yet, and adds each to the Project manager's inbox, followed by
 * the milestone's hand-off.
 */
export async function digestMilestones(ctx: BuildContext): Promise<void> {
  const milestones = milestonesOf(ctx);
  const done = milestones.filter((m) => m.tasks.every((id) => ctx.task(id).status === "done"));
  for (const milestone of done) {
    const digests = (await ctx.inbox.list()).filter(
      (i) => i.kind === "digest" && i.ref.startsWith("milestone-"),
    );
    if (digests.some((i) => i.ref === `milestone-${milestone.id}`)) continue;
    const previous = digests.at(-1)?.createdAt;
    const from = previous ?? ctx.state.createdAt;
    const count = digests.length + 1;
    const file = digestFile(milestone.id);
    await reportProjectManagerUsage(ctx);
    const pmSince = previous ?? (await planningStart(ctx));
    const pm = await projectManagerUsage(ctx, { since: pmSince })
      .then((usage) => ({ ...usage, since: pmSince }))
      .catch(() => null);
    await ctx.store.writeText(
      ctx.store.path(file),
      await renderDigest(ctx, milestone, count, milestones.length, from, pm),
    );
    await ctx.toProjectManager({
      kind: "digest",
      ref: `milestone-${milestone.id}`,
      summary: `Milestone ${milestone.id} (${milestone.title}) is done: ${count} of ${milestones.length} milestones.`,
      file,
      needsAnswer: false,
    });
    await handOff(ctx, milestone, milestones);
  }
}
