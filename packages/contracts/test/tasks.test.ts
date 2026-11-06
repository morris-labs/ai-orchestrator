import { describe, expect, it } from "vitest";
import {
  markTask,
  planTasks,
  skipQueued,
  sortTasks,
  taskLabel,
  type TaskInput,
} from "../src/index.js";

const review = (key: string, groupId: string): TaskInput => ({
  key,
  round: 1,
  stage: "find",
  role: "reviewer",
  groupId,
  label: `Review ${groupId}`,
  vendor: "claude",
  effort: "high",
});

describe("task list", () => {
  it("plans queued tasks and keeps the state of a task it already has", () => {
    let tasks = planTasks([], [review("find-G01", "G01"), review("find-G02", "G02")]);
    tasks = markTask(tasks, review("find-G01", "G01"), "running");
    tasks = planTasks(tasks, [review("find-G01", "G01")]);
    expect(tasks.map((t) => [t.key, t.state])).toEqual([
      ["find-G01", "running"],
      ["find-G02", "queued"],
    ]);
  });

  it("sorts a task that nothing planned into its stage", () => {
    let tasks = planTasks([], [review("find-G01", "G01")]);
    tasks = planTasks(tasks, [
      { key: "fix-1", round: 1, stage: "fix", role: "fixer", groupId: null, label: "Fix F-0001" },
    ]);
    tasks = markTask(
      tasks,
      {
        key: "verify-F-0001",
        round: 1,
        stage: "verify",
        role: "disprover",
        groupId: "G01",
        label: "Verify F-0001",
      },
      "running",
    );
    expect(tasks.map((t) => t.key)).toEqual(["find-G01", "verify-F-0001", "fix-1"]);
    expect(sortTasks(tasks)).toEqual(tasks);
  });

  it("keeps a planned label when the call starts", () => {
    let tasks = planTasks(
      [],
      [
        {
          key: "fix-a",
          round: 1,
          stage: "fix",
          role: "fixer",
          groupId: "G01",
          label: "Fix 3 findings",
        },
      ],
    );
    tasks = markTask(
      tasks,
      {
        key: "fix-a",
        round: 1,
        stage: "fix",
        role: "fixer",
        groupId: "G01",
        label: "Fix G01",
        vendor: "codex",
      },
      "running",
    );
    expect(tasks[0]).toMatchObject({ label: "Fix 3 findings", vendor: "codex", state: "running" });
  });

  it("skips queued tasks of a stage the run left", () => {
    const tasks = skipQueued(planTasks([], [review("find-G01", "G01")]), 1, "find");
    expect(tasks[0]?.state).toBe("skipped");
  });

  it("labels calls from their role and key", () => {
    expect(taskLabel("disprover", "verify-F-0012", "G01")).toBe("Verify F-0012");
    expect(taskLabel("reviewer", "find-G03-claude-ledger1", "G03")).toBe(
      "Review G03 (coverage follow-up 1)",
    );
    expect(taskLabel("reviewer", "find-copilot", null)).toBe("Review whole diff");
  });
});
