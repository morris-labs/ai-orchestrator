// Prompt templates for every agent role. They are vendor-agnostic: each
// vendor gets the same text and returns the same JSON.
//
// Recall and precision are split on purpose (design.md, "Reviewer depth"):
// finder, continuation, and sweep prompts ask for every plausible issue, and
// only the disprover prompt carries the precision rules.
import type { Finding, Hunk } from "@agentbox/contracts";
import type { FindingsLogEntry } from "../merge/merge.js";
import {
  CONFIRM_OUTPUT_JSON_SCHEMA,
  FIX_OUTPUT_JSON_SCHEMA,
  REVIEW_OUTPUT_JSON_SCHEMA,
  SWEEP_OUTPUT_JSON_SCHEMA,
  VERIFY_OUTPUT_JSON_SCHEMA,
  jsonInstruction,
} from "./schema.js";

/** Focus areas for two reviewers on one group, so they don't report the same issues. */
export const FOCUS_AREAS: readonly (readonly string[])[] = [
  ["correctness", "error handling", "edge cases and boundary values"],
  ["security", "data exposure", "resource handling", "concurrency"],
];

/** The precision rules. They appear in the disprover prompt and nowhere else. */
export const PRECISION_RULES = [
  "Zero confirmed findings is an acceptable outcome. Disprove anything you can't support.",
  "No speculative flaws: confirm only when you can name the input or state that triggers the failure.",
  "Style, naming, and preference are not defects.",
  "A flaw in code the change didn't touch still counts, but say so: report whether it exists at the base.",
];

export interface RangeInfo {
  repoPath: string;
  baseSha: string;
  tipSha: string;
  /** The tip branch, or `null` for a commit. */
  tipRef: string | null;
}

export interface FinderPromptInput {
  range: RangeInfo;
  round: number;
  /** `null` for a whole-diff review. */
  groupId: string | null;
  files: readonly string[];
  hunks: readonly Hunk[];
  /** The diff with context for these files. */
  diff: string;
  /** Focus areas when two reviewers share the group, or `null` for all areas. */
  focusAreas: readonly string[] | null;
  findingsLog: readonly FindingsLogEntry[];
  /** From `policyPromptSection`. */
  policySection: string;
}

function hunkList(hunks: readonly Hunk[]): string {
  return hunks.map((h) => `- ${h.id}: ${h.file} lines ${h.start}-${h.end}`).join("\n");
}

export function formatFindingsLog(log: readonly FindingsLogEntry[]): string {
  if (log.length === 0) return "No findings are closed yet.";
  return log
    .map((e) => {
      const where = e.file
        ? `${e.file}${e.lines ? `:${e.lines[0]}-${e.lines[1]}` : ""}`
        : "(no location)";
      return `- ${e.id} [${e.verdict}] ${e.severity} ${e.title} (${where})${e.reason ? `: ${e.reason}` : ""}`;
    })
    .join("\n");
}

function section(title: string, body: string): string {
  return body.trim() === "" ? "" : `## ${title}\n\n${body.trim()}\n`;
}

function join(parts: readonly string[]): string {
  return parts.filter((p) => p.trim() !== "").join("\n");
}

/** The finder prompt: recall first, a verdict for every hunk, and the findings log. */
export function finderPrompt(input: FinderPromptInput): string {
  const scope = input.groupId === null ? "the whole diff" : `file group ${input.groupId}`;
  const focus = input.focusAreas
    ? `Concentrate on ${input.focusAreas.join(", ")}. Another reviewer covers the other areas, but report anything else you notice too.`
    : "Cover every area: correctness, error handling, security, data exposure, resource handling, concurrency, and performance.";
  return join([
    `You are a code reviewer in round ${input.round} of an automated review. Review ${scope} of the change from ${input.range.baseSha} to ${input.range.tipSha} in the repository at ${input.range.repoPath}.`,
    "",
    "You are read-only: don't edit files, commit, or run commands that change the repository. You can read any file and run read-only commands.",
    "",
    section(
      "How to report",
      [
        "Report every plausible issue you find. There is no cap on the number of findings.",
        "A separate verifier checks each finding and removes false positives, so don't hold back an issue because you aren't certain. A missed bug costs more than a finding the verifier rejects.",
        "Keep reading until you have examined every hunk below. Don't stop after the first few issues.",
        focus,
        "For each finding, give the failure case: the input or state, and the wrong behavior it leads to.",
        "Set `introduced` to false when the flaw already exists in the base version.",
      ].join("\n"),
    ),
    section(
      "Coverage ledger",
      [
        "Return a ledger entry for every hunk id below: `findings` when the hunk has at least one finding, or `sound` with a one-line reason when you examined it and found nothing.",
        "",
        hunkList(input.hunks),
      ].join("\n"),
    ),
    section("Files", input.files.map((f) => `- ${f}`).join("\n")),
    section(
      "Findings log",
      [
        "These findings are already closed. Don't report them again unless the code still has the flaw after its fix:",
        "",
        formatFindingsLog(input.findingsLog),
      ].join("\n"),
    ),
    section("Repository policy", input.policySection),
    section("Diff", `\`\`\`diff\n${input.diff.trimEnd()}\n\`\`\``),
    jsonInstruction(REVIEW_OUTPUT_JSON_SCHEMA),
  ]);
}

export interface ContinuationPromptInput {
  /** Titles you already reported in this session, to exclude. */
  reported: readonly string[];
}

/** Resumes the same reviewer to drain what it hasn't reported yet. */
export function continuationPrompt(input: ContinuationPromptInput): string {
  return join([
    "Keep reviewing the same change. List issues that are not yet on your list.",
    "Look again at the hunks where you found problems: bugs cluster. Then look at the hunks you marked sound with fresh eyes.",
    "Report every plausible issue; the verifier removes false positives. Return an empty `findings` array only when nothing new remains.",
    "",
    "Already reported:",
    input.reported.length > 0 ? input.reported.map((t) => `- ${t}`).join("\n") : "- (nothing)",
    "",
    "Repeat ledger entries only for hunks whose verdict changed.",
    jsonInstruction(REVIEW_OUTPUT_JSON_SCHEMA),
  ]);
}

/** Sends hunks without a verdict back to the same session. */
export function ledgerFollowUpPrompt(missing: readonly Hunk[]): string {
  return join([
    "Your ledger has no verdict for these hunks. Examine each one and return a ledger entry for it, plus any findings:",
    "",
    hunkList(missing),
    "",
    jsonInstruction(REVIEW_OUTPUT_JSON_SCHEMA),
  ]);
}

export interface SweepPromptInput {
  range: RangeInfo;
  /** Confirmed findings, each a pattern to search for. */
  patterns: readonly Finding[];
  /** The whole diff with context. */
  diff: string;
  policySection: string;
}

/** The pattern sweep: other instances of each confirmed pattern across the whole diff. */
export function sweepPrompt(input: SweepPromptInput): string {
  const patterns = input.patterns
    .map(
      (f) =>
        `- ${f.id} ${f.title} (${f.file ?? "no file"}${f.lines ? `:${f.lines[0]}-${f.lines[1]}` : ""}): ${f.failureCase}`,
    )
    .join("\n");
  return join([
    `Each confirmed finding below is a pattern. Search the whole change from ${input.range.baseSha} to ${input.range.tipSha} in ${input.range.repoPath} for other instances of each pattern: the same mistake in another function, file, or call site.`,
    "You are read-only. Report every other instance you find, with its own location and failure case. Don't report the instances listed here again.",
    "",
    section("Patterns", patterns),
    section("Repository policy", input.policySection),
    section("Diff", `\`\`\`diff\n${input.diff.trimEnd()}\n\`\`\``),
    jsonInstruction(SWEEP_OUTPUT_JSON_SCHEMA),
  ]);
}

export interface DisproverPromptInput {
  range: RangeInfo;
  finding: Finding;
  /** Where the agent may write reproduction scripts. */
  scratchDir: string;
  /** A checkout of the pinned base, for the pre-existing check. */
  baseWorktree: string;
  policySection: string;
}

/** The disprover: tries to disprove one finding, with the precision rules. */
export function disproverPrompt(input: DisproverPromptInput): string {
  const f = input.finding;
  return join([
    "You verify one finding from another reviewer. Try to disprove it. Confirm it only when the evidence holds.",
    "",
    section(
      "Finding",
      [
        `Id: ${f.id}`,
        `Severity: ${f.severity}`,
        `Title: ${f.title}`,
        `Location: ${f.file ?? "(none)"}${f.lines ? ` lines ${f.lines[0]}-${f.lines[1]}` : ""}`,
        `Category: ${f.category}`,
        `Failure case: ${f.failureCase}`,
        f.origin === "pr_comment" || f.origin === "check_run"
          ? `Source: ${f.origin}\n${f.evidence}`
          : "",
      ].join("\n"),
    ),
    section("Rules", PRECISION_RULES.map((r) => `- ${r}`).join("\n")),
    section(
      "How to verify",
      [
        `The repository at the tip is ${input.range.repoPath}. Don't edit it.`,
        `A checkout of the base (${input.range.baseSha}) is at ${input.baseWorktree}. Don't edit it.`,
        `Where you can, write a reproduction script in the scratch directory ${input.scratchDir}, the only place you may write. The script must exit 1 when the flaw reproduces and 0 when it doesn't, must let any other failure exit with a different code, and must take the repository directory as its first argument, so it runs against both checkouts.`,
        "The engine runs your script against the tip and the base; you might not be able to run it yourself. Return its path relative to the scratch directory, or `null` when you verified by reading the code. When you can't write the file, put its text in `script.content` and the engine writes it.",
        "Base your verdict and `presentAtBase` on your own reading too: a script that doesn't run counts for nothing.",
        "Set `presentAtBase` to true when the same flaw exists in the base checkout.",
      ].join("\n"),
    ),
    section("Repository policy", input.policySection),
    jsonInstruction(VERIFY_OUTPUT_JSON_SCHEMA),
  ]);
}

export interface FixerPromptInput {
  range: RangeInfo;
  findings: readonly Finding[];
  /** The gate's failure report when a fix broke tests or lint; absent on the first try. */
  gateFailure?: string;
  policySection: string;
}

/** The fixer: fixes confirmed findings on the tip branch and commits. */
export function fixerPrompt(input: FixerPromptInput): string {
  const list = input.findings
    .map(
      (f) =>
        `- ${f.id} [${f.severity}] ${f.title} (${f.file ?? "no file"}${f.lines ? `:${f.lines[0]}-${f.lines[1]}` : ""})\n  Failure case: ${f.failureCase}\n  Evidence: ${f.evidence.replace(/\s+/g, " ").slice(0, 600)}`,
    )
    .join("\n");
  return join([
    `Fix the confirmed findings below in ${input.range.repoPath} on the branch ${input.range.tipRef ?? "(checked out)"}.`,
    "",
    "- Fix the root cause, not the symptom, and fix every instance the finding names.",
    "- Add or update a test that fails without the fix where the repository has tests.",
    "- Keep each change as small as the fix allows. Don't refactor unrelated code.",
    "- Commit your changes on the current branch with a message that names the finding ids. Don't switch branches, rebase, amend earlier commits, or push.",
    "- When a finding is not a real defect after all, leave the code and list it under `notFixed` with the reason.",
    "",
    section("Findings", list),
    input.gateFailure
      ? section(
          "Gate failure",
          `Your previous fix broke the test or lint gate. Fix the regression first:\n\n${input.gateFailure}`,
        )
      : "",
    section("Repository policy", input.policySection),
    jsonInstruction(FIX_OUTPUT_JSON_SCHEMA),
  ]);
}

export interface ConfirmerPromptInput {
  range: RangeInfo;
  findings: readonly Finding[];
  /** The diff of the fix commits. */
  fixDiff: string;
  policySection: string;
}

/** The confirmer: reviews the fix diff for incomplete fixes and new issues. */
export function confirmerPrompt(input: ConfirmerPromptInput): string {
  const list = input.findings
    .map((f) => `- ${f.id} [${f.severity}] ${f.title} (${f.file ?? "no file"}): ${f.failureCase}`)
    .join("\n");
  return join([
    `Another agent fixed the findings below in ${input.range.repoPath}. Review the fix diff. You are read-only.`,
    "",
    "- List under `incomplete` every finding whose fix doesn't remove the failure case, with the reason.",
    "- List under `findings` every regression or new issue the fix introduced. Report every plausible one; a verifier checks them.",
    "",
    section("Fixed findings", list),
    section("Repository policy", input.policySection),
    section("Fix diff", `\`\`\`diff\n${input.fixDiff.trimEnd()}\n\`\`\``),
    jsonInstruction(CONFIRM_OUTPUT_JSON_SCHEMA),
  ]);
}
