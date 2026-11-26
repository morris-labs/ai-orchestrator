// The other tasks as a task's gate sees them: the finished tasks, whose
// tests must still pass, and the test files of the unfinished ones, which
// the gate sets aside. A locked test file that no task's planned tests list
// belongs to the tasks whose criteria its tests check.
import { describe, expect, it } from "vitest";
import { otherTasks, type OtherTasksInput } from "../../src/build/other-tasks.js";

const TASKS: OtherTasksInput["tasks"] = [
  { id: "T1", criteria: ["AC1"], tests: ["test/cart.test.mjs"] },
  { id: "T2", criteria: ["AC2"], tests: ["test/label.test.mjs"] },
  { id: "T3", criteria: ["AC3"], tests: ["test/tax.test.mjs"] },
];

/** A lock with each task's planned test, and a test for `criterion` in a file no task lists. */
function lockWith(criterion: string): OtherTasksInput["lock"] {
  return {
    tests: [
      { file: "test/cart.test.mjs", criterion: "AC1" },
      { file: "test/label.test.mjs", criterion: "AC2" },
      { file: "test/tax.test.mjs", criterion: "AC3" },
      { file: "test/more.test.mjs", criterion },
    ],
  };
}

function input(criterion: string, done: readonly string[]): OtherTasksInput {
  return { tasks: TASKS, done: (id) => done.includes(id), lock: lockWith(criterion) };
}

describe("otherTasks", () => {
  it("sets aside a locked file outside every task's tests while the task it tests is unfinished", () => {
    expect(otherTasks(input("AC2", []), "T1")).toEqual({
      earlier: [],
      pending: ["test/label.test.mjs", "test/tax.test.mjs", "test/more.test.mjs"],
    });
  });

  it("holds a finished task to such a file, as to its planned tests", () => {
    expect(otherTasks(input("AC2", ["T2"]), "T1")).toEqual({
      earlier: [{ id: "T2", tests: ["test/label.test.mjs", "test/more.test.mjs"] }],
      pending: ["test/tax.test.mjs"],
    });
  });

  it("leaves such a file in place for the task whose criterion it tests", () => {
    expect(otherTasks(input("AC1", []), "T1").pending).not.toContain("test/more.test.mjs");
  });

  it("leaves a file in place that also tests the task or a finished task", () => {
    const lock = lockWith("AC2");
    const mixed = {
      tasks: TASKS,
      done: (id: string) => id === "T3",
      lock: { tests: [...(lock?.tests ?? []), { file: "test/more.test.mjs", criterion: "AC1" }] },
    };
    expect(otherTasks(mixed, "T1").pending).not.toContain("test/more.test.mjs");
  });

  it("works without a lock", () => {
    expect(otherTasks({ tasks: TASKS, done: () => false, lock: null }, "T1")).toEqual({
      earlier: [],
      pending: ["test/label.test.mjs", "test/tax.test.mjs"],
    });
  });
});
