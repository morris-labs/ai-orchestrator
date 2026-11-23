// Test disputes: a Developer that believes a locked test is wrong says so in
// its report's `dispute` field, with the test and its reason. The dispute
// doesn't count as a gate attempt: once it's settled, the attempt runs
// again. It ends in one of four ways:
//
// - Amended: the Test engineer fixes the test. The fixed test must pass the
//   red check against the code as it was before the task, then the engine
//   commits it, locks it again, and records the amendment in the lock.
// - Rejected: the Test engineer answers with its reason, and the test stands.
// - Ruled on: a second dispute about one test, or a third in one task, goes
//   to the Project manager as an escalation.
// - Escalated: an amendment that changes what a criterion means goes to the
//   owner. The engine saves the amendment as a patch, and locks it only when
//   the owner's resolution changes the criteria.
//
// Each dispute saves `tasks/TASK/dispute-N.json` as it goes, so a restarted
// build continues from the last finished part.
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BuildTask, Escalation } from "@aio/contracts";
import { z } from "zod";
import { RunCancelled } from "../calls/index.js";
import type { AdapterOutput } from "../core.js";
import { untrusted } from "../prompts/templates.js";
import type { BuildContext } from "./context.js";
import type { EscalationDraft } from "./escalations.js";
import { outsideWritable } from "./gate.js";
import { runRedCheck, type ListedTest, type RedCheck } from "./red-check.js";
import { rolePrompt, type RoleTask } from "./roles/index.js";
import { TEST_ENGINEER } from "./steps/tests-first.js";
import {
  amendLock,
  checkLock,
  lockFiles,
  readTestLock,
  writeTestLock,
  type TestLock,
} from "./test-lock.js";

/** How a test dispute ended. */
export type DisputeOutcome = "amended" | "rejected" | "ruled" | "escalated";

/** A Developer's test dispute, as its report gives it. */
export interface DisputeClaim {
  test: string;
  reason: string;
}

/** One test dispute, as `tasks/TASK/dispute-N.json` saves it. */
export interface DisputeRecord {
  /** The dispute's number in its task, from 1. */
  id: number;
  taskId: string;
  /** The attempt whose answer raised the dispute. */
  attempt: number;
  /** The disputed test file, relative to the repository root. */
  test: string;
  /** The Developer's reason. */
  reason: string;
  openedAt: string;
  /** The commit that holds the task's work when the Test engineer started. */
  start?: string;
  /** The Test engineer's call key. */
  callKey?: string;
  answer?: { vendor: string; model: string; output: Record<string, unknown> };
  /** The task's changed paths that the red check put back to the task's base. */
  held?: string[];
  /** The red check of the amended test, against the code as it was before the task. */
  check?: RedCheck;
  /** The amendment that waits for the owner, relative to the build directory. */
  amendment?: string;
  /** The escalation that took the dispute, for `ruled` and `escalated`. */
  escalation?: string;
  outcome?: DisputeOutcome;
  /** Why the dispute ended the way it did, for the Developer's next try. */
  note?: string;
  settledAt?: string;
}

/** The Developer's test dispute in a report, or `null` when it gives none. */
export function disputeOf(output: Record<string, unknown>): DisputeClaim | null {
  const dispute = output.dispute;
  if (typeof dispute !== "object" || dispute === null) return null;
  const { test, reason } = dispute as Record<string, unknown>;
  if (typeof test !== "string" || test.trim() === "") return null;
  return { test: test.trim(), reason: typeof reason === "string" ? reason : "" };
}

/** A dispute file, relative to the build directory. */
export function disputeFile(taskId: string, id: number): string {
  return `tasks/${taskId}/dispute-${id}.json`;
}

/** The Test engineer's answer to a dispute. */
const VERDICT_JSON = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason", "changesCriterion"],
  properties: {
    verdict: {
      type: "string",
      enum: ["amend", "reject"],
      description: "amend when you fixed the test, reject when the test is right as it is.",
    },
    reason: {
      type: "string",
      description: "Why, in at most three sentences. The Developer reads it.",
    },
    changesCriterion: {
      type: "boolean",
      description:
        "True when your fix changes what an acceptance criterion means, not only how the test checks it.",
    },
    tests: {
      type: "array",
      description:
        "With amend: every test in the disputed file after your fix. Leave it out when the names and commands didn't change.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "name", "criterion", "command"],
        properties: {
          file: { type: "string" },
          name: { type: "string" },
          criterion: { type: "string" },
          command: { type: "string" },
        },
      },
    },
  },
} as const;

const VERDICT_OUTPUT: AdapterOutput = { schema: z.record(z.unknown()), json: VERDICT_JSON };

/** Disputes about a test before a second one goes to the Project manager. */
export const DISPUTES_PER_TEST = 1;
/** Disputes in a task before a third one goes to the Project manager. */
export const DISPUTES_PER_TASK = 2;

function now(ctx: BuildContext): string {
  return new Date(ctx.services.clock.now()).toISOString();
}

/** Every dispute of the build, in task order. */
async function allDisputes(ctx: BuildContext): Promise<DisputeRecord[]> {
  const records: DisputeRecord[] = [];
  for (const task of ctx.plan.tasks) {
    const dir = ctx.store.path("tasks", task.id);
    if (!existsSync(dir)) continue;
    const names = (await readdir(dir)).filter((n) => /^dispute-\d+\.json$/.test(n));
    for (const name of names) {
      const record = await ctx.store.readJson<DisputeRecord>(ctx.store.path("tasks", task.id, name));
      if (record) records.push(record);
    }
  }
  return records;
}

/** The number the next dispute of `taskId` gets. */
export async function nextDisputeId(ctx: BuildContext, taskId: string): Promise<number> {
  const mine = (await allDisputes(ctx)).filter((d) => d.taskId === taskId);
  return Math.max(0, ...mine.map((d) => d.id)) + 1;
}

/** Saves a new dispute; one that a restarted build saved already stays as it is. */
export async function openDispute(
  ctx: BuildContext,
  task: BuildTask,
  id: number,
  attempt: number,
  claim: DisputeClaim,
): Promise<DisputeRecord> {
  const path = ctx.store.path(disputeFile(task.id, id));
  const saved = await ctx.store.readJson<DisputeRecord>(path);
  if (saved) return saved;
  const record: DisputeRecord = {
    id,
    taskId: task.id,
    attempt,
    test: claim.test,
    reason: claim.reason,
    openedAt: now(ctx),
  };
  await ctx.store.writeJson(path, record);
  return record;
}

async function save(ctx: BuildContext, record: DisputeRecord): Promise<void> {
  await ctx.store.writeJson(ctx.store.path(disputeFile(record.taskId, record.id)), record);
}

async function settle(
  ctx: BuildContext,
  record: DisputeRecord,
  outcome: DisputeOutcome,
  note: string,
): Promise<void> {
  record.outcome = outcome;
  record.note = note;
  record.settledAt = now(ctx);
  await save(ctx, record);
}

/** The dispute's history for an escalation: every dispute about the test or in the task. */
function history(record: DisputeRecord, earlier: readonly DisputeRecord[]): string {
  return [...earlier, record]
    .map(
      (d) =>
        `- ${disputeFile(d.taskId, d.id)}: task ${d.taskId}, ${d.test}, ${d.outcome ?? "open"}. Reason: ${d.reason || "none given"}${d.note ? ` Outcome: ${d.note}` : ""}`,
    )
    .join("\n");
}

/** The escalation for a dispute that the Project manager rules on, or `null` when the Test engineer takes it. */
async function ruling(ctx: BuildContext, record: DisputeRecord): Promise<EscalationDraft | null> {
  const others = (await allDisputes(ctx)).filter(
    (d) => !(d.taskId === record.taskId && d.id === record.id),
  );
  const sameTest = others.filter((d) => d.test === record.test);
  const sameTask = others.filter((d) => d.taskId === record.taskId);
  if (sameTest.length < DISPUTES_PER_TEST && sameTask.length < DISPUTES_PER_TASK) return null;
  const why =
    sameTest.length >= DISPUTES_PER_TEST
      ? `${record.test} was disputed before`
      : `task ${record.taskId} disputed tests ${sameTask.length} times before`;
  return {
    kind: "test_dispute",
    level: "project_manager",
    taskId: record.taskId,
    summary: `Task ${record.taskId} disputes ${record.test} again: ${why}, so the Project manager rules on it.`,
    details: [
      `Rule on the dispute. Resolve with clarify and a note that the Developer reads, or with retry to keep the test as it is. A ruling that changes what a criterion means is the owner's.`,
      "",
      "Disputes:",
      history(record, [...new Set([...sameTest, ...sameTask])]),
    ].join("\n"),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The tests of the disputed file that the Test engineer lists, or the locked ones when it lists none that fit. */
function amendedTests(
  ctx: BuildContext,
  record: DisputeRecord,
  lock: TestLock,
  output: Record<string, unknown>,
): ListedTest[] {
  const known = new Set(ctx.plan.criteria.map((c) => c.id));
  const listed: ListedTest[] = [];
  for (const entry of Array.isArray(output.tests) ? (output.tests as unknown[]) : []) {
    const fields =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const file = text(fields.file);
    const name = text(fields.name);
    const criterion = text(fields.criterion);
    const command = text(fields.command);
    if (file !== record.test || !name || !criterion || !command || !known.has(criterion)) continue;
    listed.push({ file, name, criterion, command });
  }
  return listed.length > 0 ? listed : lock.tests.filter((t) => t.file === record.test);
}

function roleTask(ctx: BuildContext, task: BuildTask, record: DisputeRecord, lock: TestLock): RoleTask {
  const locked = lock.tests.filter((t) => t.file === record.test);
  const ids = new Set([...task.criteria, ...locked.map((t) => t.criterion)]);
  return {
    id: `${task.id}-dispute-${record.id}`,
    title: `Test dispute ${record.id} of task ${task.id} about ${record.test}`,
    description:
      "The Developer of the task believes a locked test is wrong. Decide whether it is, and fix it when it is.",
    repoPath: ctx.worktree.path,
    branch: ctx.state.branch,
    ownedFiles: [record.test],
    contracts: task.contracts,
    criteria: ctx.plan.criteria.filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, text: c.text })),
    tests: [record.test],
    context: [
      `This is a test dispute: the Developer of task ${task.id} says that ${record.test} is wrong. Its reason follows.`,
      "",
      untrusted(record.reason || "No reason given."),
      "",
      "The locked tests in the file:",
      ...locked.map((t) => `- ${t.name} (${t.criterion}): \`${t.command}\``),
      "",
      "Judge the test against the acceptance criteria, not against the Developer's code. When the test is wrong, fix it in the file and answer amend. The fixed test must still fail on an assertion against the code as it was before the task. When the test is right, leave the file as it is and answer reject with the reason. When your fix changes what a criterion means, set changesCriterion: the owner decides that. Change no other file.",
    ].join("\n"),
  };
}

/** The Test engineer's turn for a dispute; its session goes into the session registry. */
async function callTestEngineer(
  ctx: BuildContext,
  task: BuildTask,
  record: DisputeRecord,
  lock: TestLock,
): Promise<NonNullable<DisputeRecord["answer"]>> {
  const role = ctx.role(TEST_ENGINEER);
  const key = record.callKey ?? `${task.id}-dispute-${record.id}`;
  const specialties = await ctx.specialties(task.specialties);
  const brief = roleTask(ctx, task, record, lock);
  const outcome = await ctx.sessions.run(
    TEST_ENGINEER,
    async () => {
      const placement = ctx.seats.place(TEST_ENGINEER);
      const answer = await ctx.callTurn({
        seat: TEST_ENGINEER,
        taskId: task.id,
        key,
        step: "tasks",
        task: brief,
        prompt: rolePrompt(
          {
            ...role,
            outputs: [
              {
                name: "verdict",
                description: "Whether you amended the test or rejected the dispute, and why.",
                schema: VERDICT_JSON as unknown as Record<string, unknown>,
              },
            ],
          },
          { ...brief, specialties },
        ),
        placement,
        specialties,
        output: VERDICT_OUTPUT,
      });
      await ctx.sessions.started({
        seat: TEST_ENGINEER,
        taskIds: [task.id],
        task: brief,
        specialties: specialties.map((p) => p.name),
        step: "tasks",
        key,
        placement,
        outcome: answer,
      });
      return answer;
    },
    [task.id],
  );
  return { vendor: outcome.vendor, model: outcome.model, output: outcome.output };
}

/**
 * Runs the red check of the amended tests against the code as it was before
 * the task: the task's other changes are put back to its base for the run,
 * then restored from `record.start`.
 */
async function redCheck(
  ctx: BuildContext,
  task: BuildTask,
  record: DisputeRecord,
  tests: readonly ListedTest[],
): Promise<RedCheck> {
  const start = record.start;
  if (!start) throw new Error(`Dispute ${disputeFile(task.id, record.id)} has no start.`);
  const base = ctx.task(task.id).base ?? ctx.state.base;
  const held = (await ctx.worktree.changedSince(base)).filter((p) => p !== record.test);
  record.held = held;
  await save(ctx, record);
  await ctx.worktree.restorePaths(base, held);
  try {
    return await runRedCheck({
      worktree: ctx.worktree,
      tests,
      holds: new Set(ctx.plan.criteria.filter((c) => c.alreadyHolds).map((c) => c.id)),
      shell: ctx.services.shell,
      signal: ctx.signal,
    });
  } finally {
    await ctx.worktree.restorePaths(start, held);
    delete record.held;
    await save(ctx, record);
  }
}

/**
 * Checks the amended test and locks it, or settles the dispute as rejected
 * when the amended test fails the red check.
 */
async function amend(
  ctx: BuildContext,
  task: BuildTask,
  record: DisputeRecord,
  lock: TestLock,
  output: Record<string, unknown>,
): Promise<void> {
  const tests = amendedTests(ctx, record, lock, output);
  const check = await redCheck(ctx, task, record, tests);
  if (ctx.signal.aborted) throw new RunCancelled();
  record.check = check;
  if (!check.passed) {
    await ctx.worktree.restorePaths(record.start ?? lock.commit, [record.test]);
    await settle(
      ctx,
      record,
      "rejected",
      `The Test engineer's fix failed the red check, so the test stands as it is locked: ${check.problems.join(" ")}`,
    );
    return;
  }
  const reason = text(output.reason) ?? "No reason given.";
  const commit = await ctx.worktree.commitAll(
    `test(build): amend ${record.test} after test dispute ${record.id} of task ${task.id}`,
  );
  const [file] = await lockFiles(ctx.worktree, [record.test]);
  if (!file) throw new Error(`The amended test ${record.test} doesn't exist.`);
  await writeTestLock(
    ctx.store,
    amendLock(
      lock,
      {
        dispute: disputeFile(task.id, record.id),
        taskId: task.id,
        test: record.test,
        reason,
        commit,
        at: now(ctx),
      },
      file,
      tests,
    ),
  );
  await settle(ctx, record, "amended", `The Test engineer fixed the test: ${reason}`);
}

/** Commits the task's work, so the Test engineer's changes stand apart from it. Returns `HEAD`. */
async function saveTaskWork(ctx: BuildContext, task: BuildTask, record: DisputeRecord): Promise<string> {
  if (await ctx.worktree.dirty()) {
    await ctx.worktree.commitAll(
      `chore(build): save task ${task.id}'s work before test dispute ${record.id}`,
    );
  }
  return ctx.worktree.head();
}

/** Picks up an escalated dispute after the owner's resolution: a change to the criteria locks the amendment. */
async function afterOwner(
  ctx: BuildContext,
  task: BuildTask,
  record: DisputeRecord,
  escalation: Escalation,
  lock: TestLock,
): Promise<void> {
  const accepted = escalation.resolution?.changes.includes("criteria") ?? false;
  const patch = record.amendment ? ctx.store.path(record.amendment) : null;
  if (!accepted || !patch || !existsSync(patch) || !record.answer) return;
  record.start = await saveTaskWork(ctx, task, record);
  await save(ctx, record);
  if (!(await ctx.worktree.bringBack(patch))) {
    record.note = `The owner accepted the amendment, but it no longer applies to ${record.test}, so the test stands as it is locked.`;
    await save(ctx, record);
    return;
  }
  await amend(ctx, task, record, lock, record.answer.output);
  record.note = `The owner accepted the amendment. ${record.note ?? ""}`.trim();
  await save(ctx, record);
}

/**
 * Settles dispute `id` of `task`. Returns `"settled"` when the attempt can
 * run again, and `"wait"` when the dispute escalated and the task waits for
 * a decision.
 */
export async function settleDispute(
  ctx: BuildContext,
  task: BuildTask,
  id: number,
): Promise<"settled" | "wait"> {
  const record = await ctx.store.readJson<DisputeRecord>(ctx.store.path(disputeFile(task.id, id)));
  if (!record) throw new Error(`Task ${task.id} has no dispute ${id}.`);
  // A red check that a stop cut short left the task's work put back.
  if (record.held && record.start) {
    await ctx.worktree.restorePaths(record.start, record.held);
    delete record.held;
    await save(ctx, record);
  }
  const lock = await readTestLock(ctx.store);
  if (record.outcome === "amended" || record.outcome === "rejected") return "settled";
  if (record.outcome === "ruled" || record.outcome === "escalated") {
    const escalation = ctx.state.escalations.find((e) => e.id === record.escalation);
    if (escalation?.status === "open") return "wait";
    if (record.outcome === "escalated" && escalation && lock) {
      await afterOwner(ctx, task, record, escalation, lock);
    }
    return "settled";
  }
  if (!lock) {
    await settle(ctx, record, "rejected", "The build has no locked tests, so there is nothing to dispute.");
    return "settled";
  }
  if (!lock.files.some((f) => f.path === record.test)) {
    await settle(
      ctx,
      record,
      "rejected",
      `${record.test} isn't a locked test. The locked tests are: ${lock.files.map((f) => f.path).join(", ")}.`,
    );
    return "settled";
  }
  const ruled = await ruling(ctx, record);
  if (ruled) {
    const escalation = await ctx.escalate(ruled);
    record.escalation = escalation.id;
    await settle(ctx, record, "ruled", `The Project manager rules on the dispute in escalation ${escalation.id}.`);
    return "wait";
  }
  if (!record.answer) {
    // A Developer's change to a locked test never reaches the Test engineer.
    const changed = await checkLock(ctx.worktree, lock);
    if (!changed.passed) await ctx.worktree.restorePaths(lock.commit, changed.changed);
    record.start ??= await saveTaskWork(ctx, task, record);
    record.callKey ??= `${task.id}-dispute-${record.id}`;
    await save(ctx, record);
    record.answer = await callTestEngineer(ctx, task, record, lock);
    await save(ctx, record);
  }
  const start = record.start ?? lock.commit;
  const outside = outsideWritable(await ctx.worktree.changedSince(start), [record.test]);
  if (outside.length > 0) await ctx.worktree.restorePaths(start, outside);
  const output = record.answer.output;
  const reason = text(output.reason) ?? "No reason given.";
  const changed = (await ctx.worktree.changedSince(start)).includes(record.test);
  if (output.verdict !== "amend" || !changed) {
    await ctx.worktree.restorePaths(start, [record.test]);
    await settle(
      ctx,
      record,
      "rejected",
      output.verdict === "amend"
        ? `The Test engineer agreed but didn't change the test, so it stands: ${reason}`
        : `The Test engineer kept the test: ${reason}`,
    );
    return "settled";
  }
  if (output.changesCriterion === true) {
    const file = `tasks/${task.id}/dispute-${record.id}.patch`;
    const patch = ctx.store.path(file);
    await mkdir(dirname(patch), { recursive: true });
    await ctx.worktree.git.run([
      "diff",
      "--binary",
      `--output=${patch}`,
      start,
      "--",
      record.test,
    ]);
    await ctx.worktree.restorePaths(start, [record.test]);
    record.amendment = file;
    const escalation = await ctx.escalate({
      kind: "test_dispute",
      level: "owner",
      taskId: task.id,
      summary: `The Test engineer's fix of ${record.test} changes what a criterion means, so the owner decides it.`,
      details: [
        `Task ${task.id}'s Developer disputed ${record.test}, and the Test engineer's fix changes an acceptance criterion. Resolve with changes: criteria to accept the fix, which the engine then checks and locks, or with retry to keep the test as it is locked.`,
        "",
        `Developer's reason: ${record.reason || "none given"}`,
        `Test engineer's reason: ${reason}`,
        "",
        `Amendment: ${file}. Dispute: ${disputeFile(task.id, record.id)}.`,
      ].join("\n"),
    });
    record.escalation = escalation.id;
    await settle(ctx, record, "escalated", `The owner decides the fix in escalation ${escalation.id}.`);
    return "wait";
  }
  await amend(ctx, task, record, lock, output);
  return "settled";
}

/** The context line for the attempt that runs again after dispute `record`. */
export function disputeContext(record: DisputeRecord, escalation: Escalation | undefined): string {
  const lines = [
    `Your test dispute ${record.id} about ${record.test} is ${record.outcome ?? "settled"}. ${record.note ?? ""}`.trim(),
  ];
  if (record.outcome === "amended") {
    lines.push("The fixed test is locked; make it pass.");
  } else if (escalation?.resolution) {
    const note = escalation.resolution.note;
    lines.push(
      note
        ? `The ${escalation.resolution.by === "owner" ? "owner" : "Project manager"} decided:\n\n${untrusted(note)}`
        : "The decision keeps the test as it is locked.",
    );
  } else {
    lines.push("The test stands as it is locked; make it pass.");
  }
  lines.push("The dispute didn't count as an attempt.");
  return lines.join("\n");
}
