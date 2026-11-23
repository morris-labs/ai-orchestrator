// The build's `STATUS.md` file. The Project manager's session can compact or
// restart many times during a build, so it doesn't hold the build in its
// context: it rereads this file and the build plan instead. The engine
// rewrites the file every time it saves the build's state.
import type { BuildPlan, BuildState } from "@aio/contracts";

function cell(text: string | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** Renders the status file for `state`. */
export function renderStatus(state: BuildState, plan: BuildPlan): string {
  const titles = new Map(plan.tasks.map((t) => [t.id, t.title]));
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
    `- Updated: ${state.updatedAt}`,
    ...(state.note ? [`- Note: ${state.note}`] : []),
    "",
    "## Tasks",
    "",
    "| Task | Title | Status | Attempts | Commit | Last failure |",
    "|---|---|---|---|---|---|",
    ...state.tasks.map(
      (t) =>
        `| ${t.id} | ${cell(titles.get(t.id))} | ${t.status} | ${t.attempts} | ${t.commit ? `\`${t.commit.slice(0, 12)}\`` : ""} | ${cell(t.lastFailure)} |`,
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
