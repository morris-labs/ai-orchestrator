// The task graph of a build plan: each task names the tasks it depends on,
// and the engine runs a task only after every task it depends on.

/** A task as the graph sees it: its ID and the IDs of the tasks it depends on. */
export interface GraphTask {
  id: string;
  dependsOn: readonly string[];
}

/**
 * A dependency cycle in `tasks`, as task IDs that start and end with the
 * same task, where each task depends on the next one; `null` when the graph
 * has no cycle. Dependencies on unknown tasks are ignored.
 */
export function dependencyCycle(tasks: readonly GraphTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const finished = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    const at = path.indexOf(id);
    if (at >= 0) return [...path.slice(at), id];
    if (finished.has(id)) return null;
    path.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    finished.add(id);
    return null;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

/** The message for a dependency cycle, such as `T1 -> T2 -> T1`. */
export function cycleMessage(cycle: readonly string[]): string {
  return `the tasks form a dependency cycle: ${cycle.join(" -> ")} (each task depends on the next)`;
}

/**
 * `tasks` in the order they run: each task after every task it depends on,
 * and otherwise in plan order. Throws when the graph has a cycle.
 */
export function taskOrder<T extends GraphTask>(tasks: readonly T[]): T[] {
  const cycle = dependencyCycle(tasks);
  if (cycle) throw new Error(cycleMessage(cycle));
  const known = new Set(tasks.map((t) => t.id));
  const placed = new Set<string>();
  const order: T[] = [];
  while (order.length < tasks.length) {
    const next = tasks.find(
      (t) => !placed.has(t.id) && t.dependsOn.every((dep) => placed.has(dep) || !known.has(dep)),
    );
    if (!next) break;
    placed.add(next.id);
    order.push(next);
  }
  return order;
}

/**
 * The IDs of every task that depends on task `id`, directly or through other
 * tasks, in the order `tasks` lists them.
 */
export function dependentsOf(tasks: readonly GraphTask[], id: string): string[] {
  const found = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (!found.has(t.id) && t.dependsOn.some((dep) => found.has(dep))) {
        found.add(t.id);
        grew = true;
      }
    }
  }
  return tasks.map((t) => t.id).filter((t) => t !== id && found.has(t));
}
