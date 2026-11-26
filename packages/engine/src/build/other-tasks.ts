// The other tasks, as the gate of one task sees them: the tasks that
// finished, whose tests must still pass, and the test files of the tasks
// that haven't, which may still fail and which the gate sets aside.
//
// A task's test files are its planned `tests`. A locked test file that no
// task plans, such as one that a hand edit made, belongs to the tasks whose
// criteria its locked tests check: it's set aside while all of them are
// other unfinished tasks, and it's held to them once they finished.
import type { EarlierTask } from "./gate.js";
import { pathMatcher } from "./paths.js";

/** What `otherTasks()` reads: the plan's tasks, which tasks are done, and the test lock. */
export interface OtherTasksInput {
  tasks: readonly { id: string; criteria: readonly string[]; tests: readonly string[] }[];
  done: (taskId: string) => boolean;
  lock: { tests: readonly { file: string; criterion: string }[] } | null;
}

/** The other tasks as the gate of task `taskId` sees them. */
export function otherTasks(
  input: OtherTasksInput,
  taskId: string,
): { earlier: EarlierTask[]; pending: string[] } {
  const others = input.tasks.filter((t) => t.id !== taskId);
  const unfinished = (id: string) => id !== taskId && !input.done(id);
  const files = [...unowned(input)];
  // A file that tests only unfinished tasks goes aside; one that tests no
  // unfinished task must keep passing for the finished tasks it tests. A
  // file that tests both runs as it is.
  const aside = files.filter(([, ids]) => [...ids].every(unfinished)).map(([file]) => file);
  const held = files.filter(([, ids]) => ![...ids].some(unfinished));
  const earlier = others
    .filter((t) => input.done(t.id))
    .map((t) => ({
      id: t.id,
      tests: [...new Set([...t.tests, ...held.filter(([, ids]) => ids.has(t.id)).map(([f]) => f)])],
    }));
  const pending = others.filter((t) => !input.done(t.id)).flatMap((t) => t.tests);
  return { earlier, pending: [...new Set([...pending, ...aside])] };
}

/**
 * The locked test files that no task's planned tests cover, each with the
 * tasks whose criteria its tests check. A file whose tests check no task's
 * criterion is left out.
 */
function unowned(input: OtherTasksInput): Map<string, Set<string>> {
  const planned = pathMatcher(input.tasks.flatMap((t) => t.tests));
  const files = new Map<string, Set<string>>();
  for (const test of input.lock?.tests ?? []) {
    if (planned(test.file)) continue;
    const ids = files.get(test.file) ?? new Set<string>();
    for (const task of input.tasks) if (task.criteria.includes(test.criterion)) ids.add(task.id);
    files.set(test.file, ids);
  }
  for (const [file, ids] of files) if (ids.size === 0) files.delete(file);
  return files;
}
