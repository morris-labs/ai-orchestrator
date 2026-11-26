import { describe, expect, it } from "vitest";
import { dependencyCycle, dependentsOf, taskOrder } from "../src/index.js";

const task = (id: string, dependsOn: string[] = []) => ({ id, dependsOn });

describe("taskOrder", () => {
  it("puts every task after the tasks it depends on", () => {
    const order = taskOrder([task("T3", ["T2"]), task("T1"), task("T2", ["T1"])]);
    expect(order.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
  });

  it("keeps the plan order among tasks that are free to run", () => {
    const order = taskOrder([task("B"), task("A"), task("C", ["A", "B"]), task("D")]);
    expect(order.map((t) => t.id)).toEqual(["B", "A", "C", "D"]);
  });

  it("refuses a graph with a cycle", () => {
    expect(() => taskOrder([task("T1", ["T2"]), task("T2", ["T1"])])).toThrow(/T1 -> T2 -> T1/);
  });
});

describe("dependencyCycle", () => {
  it("returns null for a graph without a cycle", () => {
    expect(dependencyCycle([task("T1"), task("T2", ["T1"])])).toBeNull();
  });

  it("returns the cycle's tasks, starting and ending with one task", () => {
    expect(dependencyCycle([task("T1"), task("T2", ["T3"]), task("T3", ["T2"])])).toEqual([
      "T2",
      "T3",
      "T2",
    ]);
  });
});

describe("dependentsOf", () => {
  it("lists the tasks that depend on a task directly or through others, in plan order", () => {
    const tasks = [
      task("T4", ["T3"]),
      task("T1"),
      task("T2", ["T1"]),
      task("T3", ["T2"]),
      task("T5"),
    ];
    expect(dependentsOf(tasks, "T1")).toEqual(["T4", "T2", "T3"]);
    expect(dependentsOf(tasks, "T5")).toEqual([]);
  });
});
