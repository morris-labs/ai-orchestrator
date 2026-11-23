// The build's `STATUS.md` file. The Project manager's session can compact or
// restart many times during a build, so it doesn't hold the build in its
// context: it rereads this file and the build plan instead. The engine
// rewrites the file every time it saves the build's state.
import type { BuildMeeting, BuildPlan, BuildPlanning, BuildState } from "@aio/contracts";

function cell(text: string | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** Renders the status file for `state`. */
export function renderStatus(state: BuildState, plan: BuildPlan): string {
  const planned = new Map(plan.tasks.map((t) => [t.id, t]));
  const lines = [
    `# Build ${state.slug}: ${state.title}`,
    "",
    "The engine rewrites this file every time the build's state changes. After a",
    "compaction or a restart, reread it and the build plan in `plan.json`.",
    "",
    `- Status: ${state.status}${state.pausedUntil ? ` until ${state.pausedUntil}` : ""}`,
    `- Step: ${state.step}`,
    `- Branch: \`${state.branch}\`, in the worktree \`${state.worktree}\``,
    `- Base: \`${state.base}\``,
    ...(plan.issue ? [`- Issue: ${plan.issue.url}`] : []),
    `- Updated: ${state.updatedAt}`,
    ...(state.note ? [`- Note: ${state.note}`] : []),
    "",
    "## Tasks",
    "",
    "Tasks run one at a time, each after the tasks it depends on.",
    "",
    "| Task | Title | Depends on | Status | Attempts | Commit | Last failure |",
    "|---|---|---|---|---|---|---|",
    ...state.tasks.map(
      (t) =>
        `| ${t.id} | ${cell(planned.get(t.id)?.title)} | ${cell(planned.get(t.id)?.dependsOn.join(", "))} | ${t.status} | ${t.attempts} | ${t.commit ? `\`${t.commit.slice(0, 12)}\`` : ""} | ${cell(t.lastFailure)} |`,
    ),
    "",
    "## Escalations",
    "",
    ...(state.escalations.length === 0
      ? ["None."]
      : state.escalations.map(
          (e) =>
            `- ${e.id} (${e.kind}, for the ${e.level.replace("_", " ")}${e.taskId ? `, task ${e.taskId}` : ""}): ${e.summary} See \`${e.file}\`.`,
        )),
    "",
  ];
  return lines.join("\n");
}

/** Renders the status file of a build in planning, before its execution starts. */
export function renderPlanningStatus(
  planning: BuildPlanning,
  meetings: readonly BuildMeeting[] = [],
): string {
  const lines = [
    `# Build ${planning.slug}: planning`,
    "",
    "The engine rewrites this file every time the build's planning record changes.",
    "After a compaction or a restart, reread it, the planning record in",
    "`planning.json`, and the draft plan in `planning/draft.json`.",
    "",
    "- Status: planning",
    ...(planning.issue ? [`- Issue: ${planning.issue.url}`] : []),
    `- Updated: ${planning.updatedAt}`,
    "",
    "## Planning calls",
    "",
    ...(planning.calls.length === 0
      ? ["None."]
      : [
          "| Seat | Call | Status | File | Error |",
          "|---|---|---|---|---|",
          ...planning.calls.map(
            (c) => `| ${c.seat} | ${c.n} | ${c.status} | \`${c.file}\` | ${cell(c.error)} |`,
          ),
        ]),
    "",
    ...(meetings.length === 0
      ? []
      : [
          "## Meetings",
          "",
          ...meetings.flatMap((m) => [
            `- ${m.id} (\`meetings/${m.id}.json\`): ${m.status}, ${m.rounds.length} of at most ${m.roundCap} rounds, ${m.proposer} with ${m.members.join(", ")}.${m.error ? ` Error: ${m.error}` : ""}`,
            ...m.open.map((o) => `  - Open, ${o.seat}: ${o.point}`),
          ]),
          "",
        ]),
    "## Frozen plans",
    "",
    ...(planning.frozen.length === 0
      ? ["None. A freeze needs the owner's approval and push answer."]
      : planning.frozen.map(
          (f) =>
            `- Version ${f.version}: \`${f.file}\`, frozen ${f.frozenAt}. Push: ${f.push ? "allowed" : "not allowed"}.`,
        )),
    "",
  ];
  return lines.join("\n");
}
