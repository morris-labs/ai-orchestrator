// The coverage check, part of the tests first step in medium and large
// builds: an agent on a vendor other than the Test engineer's reads each
// criterion with its tests, one time, and reports each criterion that the
// tests don't check. With the single-vendor setting, a fresh agent on the
// same vendor takes the seat.
//
// The check saves `coverage-check.json` in the build directory: its call key
// first, then the answer and the gaps. A restarted build reads the saved
// report and never calls the check again.
import { VendorSchema } from "@aio/contracts";
import { untrusted } from "../../prompts/templates.js";
import type { BuildContext } from "../context.js";
import type { RoleTask } from "../roles/index.js";
import type { CheckedRound, Scope } from "./tests-first.js";

/** The seat that runs the coverage check. */
export const COVERAGE_CHECKER = "coverage-checker";

/** The coverage report, relative to the build directory. */
export const COVERAGE_REPORT_FILE = "coverage-check.json";

/** A criterion that the tests don't check, with what they miss. */
export interface CoverageGap {
  criterion: string;
  reason: string;
}

/** The coverage check, as `coverage-check.json` saves it. */
export interface CoverageReport {
  callKey: string;
  /** The round file whose tests the check read. */
  round: string;
  /** The vendor of the Test engineer whose tests the check read. */
  testVendor: string;
  answer?: { vendor: string; model: string; output: Record<string, unknown> };
  /** Each criterion that the tests don't check. Empty when every criterion is checked. */
  gaps: CoverageGap[];
  checkedAt?: string;
}

type FinishedReport = CoverageReport & { checkedAt: string };

function roleTask(ctx: BuildContext, scope: Scope, passed: CheckedRound): RoleTask {
  const tests = scope.criteria.map((criterion) => {
    const listed = passed.check.tests.filter((t) => t.criterion === criterion.id);
    const lines = listed.map((t) => `  - "${t.name}" in ${t.file}, run with \`${t.command}\``);
    return [`- ${criterion.id}:`, ...(lines.length > 0 ? lines : ["  - No test."])].join("\n");
  });
  return {
    id: "coverage-check",
    title: `Coverage check for ${ctx.plan.title}`,
    description:
      "Read each acceptance criterion with its tests, and report each criterion that the tests don't check. Don't change any file.",
    repoPath: ctx.worktree.path,
    branch: ctx.state.branch,
    ownedFiles: [],
    contracts: [...new Set(ctx.plan.tasks.flatMap((task) => task.contracts))],
    criteria: scope.criteria.map((c) => ({ id: c.id, text: c.text })),
    context: [
      "The Test engineer's tests, by criterion. The test files are in the worktree and not yet committed.",
      "",
      untrusted(tests.join("\n")),
    ].join("\n"),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The gaps in an answer: each criterion with no listed test, each one that
 * the answer marks unchecked, and each one that the answer leaves out.
 */
function gapsOf(
  scope: Scope,
  passed: CheckedRound,
  output: Record<string, unknown>,
): CoverageGap[] {
  const verdicts = new Map<string, { checked: boolean; reason: string | null }>();
  const entries: unknown[] = Array.isArray(output.criteria) ? output.criteria : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const fields = entry as Record<string, unknown>;
    const id = text(fields.id);
    if (!id || verdicts.has(id)) continue;
    verdicts.set(id, { checked: fields.checked === true, reason: text(fields.reason) });
  }
  const tested = new Set(passed.check.tests.map((t) => t.criterion));
  const gaps: CoverageGap[] = [];
  for (const { id } of scope.criteria) {
    const verdict = verdicts.get(id);
    if (!tested.has(id)) {
      gaps.push({ criterion: id, reason: "No test names this criterion." });
    } else if (!verdict) {
      gaps.push({
        criterion: id,
        reason:
          "The coverage check didn't report on this criterion, so the engine counts it as unchecked.",
      });
    } else if (!verdict.checked) {
      gaps.push({ criterion: id, reason: verdict.reason ?? "The tests don't check it." });
    }
  }
  return gaps;
}

/**
 * Runs the coverage check on the tests of round `passed`, or returns the
 * saved report when the check already ran. Throws the call's error, such as
 * `PlacementError` when the plan places the check on the Test engineer's
 * vendor without the single-vendor setting.
 */
export async function runCoverageCheck(
  ctx: BuildContext,
  scope: Scope,
  passed: CheckedRound,
): Promise<CoverageReport> {
  const path = ctx.store.path(COVERAGE_REPORT_FILE);
  let report = await ctx.store.readJson<CoverageReport>(path);
  if (report?.checkedAt) return report as FinishedReport;
  const vendor = VendorSchema.safeParse(passed.answer?.vendor);
  const testVendor = vendor.success ? vendor.data : undefined;
  if (!report) {
    report = {
      callKey: "coverage-check",
      round: `tests-first/round-${passed.round}.json`,
      testVendor: testVendor ?? "unknown",
      gaps: [],
    };
    await ctx.store.writeJson(path, report);
  }
  const outcome = await ctx.callSeat({
    seat: COVERAGE_CHECKER,
    key: report.callKey,
    step: "tests_first",
    task: roleTask(ctx, scope, passed),
    placement: testVendor ? { otherThan: testVendor } : {},
  });
  const finished: FinishedReport = {
    ...report,
    answer: { vendor: outcome.vendor, model: outcome.model, output: outcome.output },
    gaps: gapsOf(scope, passed, outcome.output),
    checkedAt: new Date(ctx.services.clock.now()).toISOString(),
  };
  await ctx.store.writeJson(path, finished);
  return finished;
}
