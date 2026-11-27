// The build's `STATUS.md` file. The Project manager's session can compact or
// restart many times during a build, so it doesn't hold the build in its
// context: it rereads this file and the build plan instead. The engine
// rewrites the file every time it saves the build's state.
import {
  engineDefectNote,
  escalationState,
  type BuildContractsProgress,
  buildFlowText,
  defaultedAnswers,
  type BuildMeeting,
  type BuildPlan,
  type BuildPlanning,
  type BuildQuestion,
  type BuildState,
  type FlowRecommendation,
} from "@aio/contracts";

/** The Analyst's recommendation line, or none for a plan without one. */
function recommendationLines(recommendation: FlowRecommendation | null | undefined): string[] {
  if (!recommendation) return [];
  const risk = recommendation.highRisk ? "high-risk" : "not high-risk";
  return [
    `- Recommended flow: ${buildFlowText(recommendation.flow)} (${risk}). ${cell(recommendation.reason)}`,
  ];
}

/**
 * The Analyst's questions: the ones the Project manager asks the owner, and
 * the ones it answers with the recommended answer. None for a spec without
 * questions.
 */
function questionLines(questions: readonly BuildQuestion[]): string[] {
  if (questions.length === 0) return [];
  const ask = questions.filter((q) => q.changesCriterion);
  const defaulted = defaultedAnswers(questions);
  return [
    "## Questions for the owner",
    "",
    "Their answers can change an acceptance criterion, so ask the owner each one.",
    "",
    ...(ask.length === 0
      ? ["None."]
      : ask.map((q) => `- ${cell(q.question)} Recommended: ${cell(q.recommendedAnswer)}`)),
    "",
    "## Defaulted answers",
    "",
    "The draft plan takes the Analyst's recommended answer for each of these.",
    "",
    ...(defaulted.length === 0
      ? ["None."]
      : defaulted.map((a) => `- ${cell(a.question)} Defaulted to: ${cell(a.answer)}`)),
    "",
  ];
}

function cell(text: string | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** The Contracts step's line: its status, attempts, commit, and last failure. */
function contractsLine(contracts: BuildContractsProgress): string {
  if (contracts.status === "skipped") return "- Contracts: skipped";
  const attempts = `${contracts.attempts} attempt${contracts.attempts === 1 ? "" : "s"}`;
  const commit = contracts.commit ? `, at \`${contracts.commit.slice(0, 12)}\`` : "";
  const failure = contracts.lastFailure ? `; last failure: ${cell(contracts.lastFailure)}` : "";
  return `- Contracts: ${contracts.status} after ${attempts}${commit}${failure}`;
}

/**
 * The line for a build that an engine defect paused: the engine defect note
 * of the latest escalation that named one.
 */
function defectLines(state: BuildState): string[] {
  const note = engineDefectNote(state);
  if (!note) return [];
  return [
    `- Paused for an engine defect: see \`${note}\`. Fix the engine in a separate session; the owner then resumes the build.`,
  ];
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
    `- Status: ${state.status}${state.idle ? " (idle)" : ""}${state.pausedUntil ? ` until ${state.pausedUntil}` : ""}`,
    `- Step: ${state.step}`,
    `- Branch: \`${state.branch}\`, in the worktree \`${state.worktree}\``,
    `- Base: \`${state.base}\``,
    ...(plan.issue ? [`- Issue: ${plan.issue.url}`] : []),
    // A plan frozen before the flow choice runs as a pipeline build.
    `- Flow: ${buildFlowText(plan.flow ?? "pipeline")}`,
    ...recommendationLines(plan.recommendation),
    `- Updated: ${state.updatedAt}`,
    ...(state.note ? [`- Note: ${state.note}`] : []),
    ...defectLines(state),
    ...(state.contracts ? [contractsLine(state.contracts)] : []),
    "",
    "## Tasks",
    "",
    "Tasks run one at a time, each after the tasks it depends on. An open",
    "escalation pauses its task and the tasks that depend on it.",
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
            `- ${e.id} (${e.kind}, for the ${e.level.replace("_", " ")}${e.taskId ? `, task ${e.taskId}` : ""}, ${escalationState(e)}): ${e.summary} See \`${e.file}\`.`,
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
    ...recommendationLines(planning.recommendation),
    `- Updated: ${planning.updatedAt}`,
    "",
    ...questionLines(planning.questions),
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
      ? ["None. A freeze needs the owner's approval, push answer, and flow choice."]
      : planning.frozen.map(
          (f) =>
            `- Version ${f.version}: \`${f.file}\`, frozen ${f.frozenAt}. Push: ${f.push ? "allowed" : "not allowed"}. Flow: ${buildFlowText(f.flow)}.`,
        )),
    "",
  ];
  return lines.join("\n");
}
