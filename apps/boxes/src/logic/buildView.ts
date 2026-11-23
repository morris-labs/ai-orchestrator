// The build view's model: the filters over a build's team chat messages, the
// agents whose slices the owner can read, the milestone board, and how
// `message.sent` and `build.task.changed` events change what the view holds.
import type {
  BuildTaskStatus,
  BuildTaskView,
  EventOf,
  Message,
  MessageParty,
  OwnerPostInput,
} from "@aio/contracts";

/** The most messages the conversation renders at first, and how many more each "Show earlier" adds. */
export const MESSAGE_WINDOW = 200;

/** The board column of tasks that no event placed in a milestone. */
export const NO_MILESTONE = "No milestone";

/**
 * The conversation's filters. `null` matches every message. A `slice` is an
 * agent's label, as `partyLabel` writes it, and keeps the messages that
 * agent received.
 */
export interface MessageFilter {
  taskId: string | null;
  milestone: string | null;
  seat: string | null;
  slice: string | null;
}

export const NO_FILTER: MessageFilter = { taskId: null, milestone: null, seat: null, slice: null };

export const taskStatusLabel: Record<BuildTaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
  blocked: "Blocked",
};

/** An agent or the owner, as the view names it: `developer (T1)`, `project-manager`, or `owner`. */
export function partyLabel(party: MessageParty): string {
  if (party.kind === "owner") return "owner";
  return party.taskId === null ? party.seat : `${party.seat} (${party.taskId})`;
}

function seatOf(party: MessageParty): string | null {
  return party.kind === "seat" ? party.seat : null;
}

/** Orders `T2` before `T10`. */
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** Each task's milestone, for the tasks an event placed in one. */
export function taskMilestones(tasks: readonly BuildTaskView[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const t of tasks) if (t.milestone !== null) map.set(t.taskId, t.milestone);
  return map;
}

/**
 * Whether a message passes every filter. A milestone matches the messages
 * about it and the messages about its tasks; a seat matches the messages
 * it sent and the messages it received.
 */
export function messageMatches(
  m: Message,
  filter: MessageFilter,
  milestones: ReadonlyMap<string, string>,
): boolean {
  if (filter.taskId !== null && m.taskId !== filter.taskId) return false;
  if (filter.milestone !== null) {
    const ofTask = m.taskId === null ? undefined : milestones.get(m.taskId);
    if (m.milestone !== filter.milestone && ofTask !== filter.milestone) return false;
  }
  if (filter.seat !== null && seatOf(m.from) !== filter.seat && seatOf(m.to) !== filter.seat) {
    return false;
  }
  if (filter.slice !== null && partyLabel(m.to) !== filter.slice) return false;
  return true;
}

export function filterMessages(
  messages: readonly Message[],
  filter: MessageFilter,
  tasks: readonly BuildTaskView[],
): Message[] {
  const milestones = taskMilestones(tasks);
  return messages.filter((m) => messageMatches(m, filter, milestones));
}

/** The values each filter offers, sorted, from the messages and the tasks. */
export interface FilterOptions {
  tasks: string[];
  milestones: string[];
  seats: string[];
  /** The agents that received at least one message, the owner included. */
  slices: string[];
}

export function filterOptions(
  messages: readonly Message[],
  tasks: readonly BuildTaskView[],
): FilterOptions {
  const taskIds = new Set<string>();
  const milestones = new Set<string>();
  const seats = new Set<string>();
  const slices = new Set<string>();
  for (const t of tasks) {
    taskIds.add(t.taskId);
    if (t.milestone !== null) milestones.add(t.milestone);
  }
  for (const m of messages) {
    if (m.taskId !== null) taskIds.add(m.taskId);
    if (m.milestone !== null) milestones.add(m.milestone);
    for (const p of [m.from, m.to]) {
      const seat = seatOf(p);
      if (seat !== null) seats.add(seat);
    }
    slices.add(partyLabel(m.to));
  }
  const sorted = (s: Set<string>) => [...s].sort(natural);
  return {
    tasks: sorted(taskIds),
    milestones: sorted(milestones),
    seats: sorted(seats),
    slices: sorted(slices),
  };
}

/** The messages agents sent straight to the owner. */
export function directMessages(messages: readonly Message[]): Message[] {
  return messages.filter((m) => m.to.kind === "owner" && m.from.kind === "seat");
}

const byNumber = (a: Message, b: Message) => Number(a.id.slice(1)) - Number(b.id.slice(1));

/**
 * Adds messages to a build's list, which stays in id order. A message the
 * list holds stays as it is, so a replayed event adds nothing, and a call
 * that adds nothing returns the same list.
 */
export function addMessages(
  list: readonly Message[],
  added: readonly Message[],
): readonly Message[] {
  const ids = new Set(list.map((m) => m.id));
  const fresh: Message[] = [];
  for (const m of added) {
    if (ids.has(m.id)) continue;
    ids.add(m.id);
    fresh.push(m);
  }
  return fresh.length === 0 ? list : [...list, ...fresh].sort(byNumber);
}

/**
 * Applies a `build.task.changed` event. An event that names no milestone
 * keeps the one the task has, as on the server.
 */
export function applyTaskChanged(
  tasks: readonly BuildTaskView[],
  event: EventOf<"build.task.changed">,
): BuildTaskView[] {
  const current = tasks.find((t) => t.taskId === event.taskId);
  const next: BuildTaskView = {
    taskId: event.taskId,
    status: event.status,
    milestone: event.milestone ?? current?.milestone ?? null,
    updatedAt: event.time,
  };
  return [...tasks.filter((t) => t !== current), next].sort((a, b) => natural(a.taskId, b.taskId));
}

/** One milestone's column on the board. */
export interface BoardColumn {
  milestone: string;
  tasks: BuildTaskView[];
}

/** The board: one column per milestone, sorted by name, and last the tasks in none. */
export function boardOf(tasks: readonly BuildTaskView[]): BoardColumn[] {
  const byMilestone = new Map<string, BuildTaskView[]>();
  const loose: BuildTaskView[] = [];
  for (const t of tasks) {
    if (t.milestone === null) loose.push(t);
    else byMilestone.set(t.milestone, [...(byMilestone.get(t.milestone) ?? []), t]);
  }
  const byId = (a: BuildTaskView, b: BuildTaskView) => natural(a.taskId, b.taskId);
  const columns = [...byMilestone.keys()]
    .sort(natural)
    .map((milestone) => ({ milestone, tasks: (byMilestone.get(milestone) ?? []).sort(byId) }));
  if (loose.length > 0) columns.push({ milestone: NO_MILESTONE, tasks: loose.sort(byId) });
  return columns;
}

/** An agent the owner can post to: a seat, and its task when several agents fill the seat. */
export interface PostTarget {
  /** The agent's label, as `partyLabel` writes it. */
  label: string;
  seat: string;
  taskId: string | null;
}

/**
 * The seats of planning that the owner can post to before they send a
 * message. A post to a seat of a meeting under way goes into the meeting.
 */
export const PLANNING_SEATS: readonly string[] = [
  "project-manager",
  "analyst",
  "architect",
  "critic",
];

/**
 * The agents the owner can post to: every agent that sent or received a
 * message, the Developer of each task, and the seats of planning.
 */
export function postTargets(
  messages: readonly Message[],
  tasks: readonly BuildTaskView[],
): PostTarget[] {
  const targets = new Map<string, PostTarget>();
  const add = (seat: string, taskId: string | null) => {
    const label = partyLabel({ kind: "seat", seat, taskId });
    if (!targets.has(label)) targets.set(label, { label, seat, taskId });
  };
  for (const m of messages) {
    for (const p of [m.from, m.to]) if (p.kind === "seat") add(p.seat, p.taskId);
  }
  for (const t of tasks) add("developer", t.taskId);
  for (const seat of PLANNING_SEATS) add(seat, null);
  return [...targets.values()].sort((a, b) => natural(a.label, b.label));
}

/**
 * What a post is about: `""` for the agent's own task, `task:ID`, or
 * `milestone:NAME`.
 */
export type PostAbout = string;

/**
 * The owner post for `target` about `about`, or `null` when the post names
 * no task and no milestone: the team chat refuses such a post, so a post to
 * an agent without a task must say what it is about. During planning, a
 * post goes into the meeting under way, which needs neither.
 */
export function ownerPostFor(
  target: PostTarget,
  about: PostAbout,
  body: string,
  planning = false,
): OwnerPostInput | null {
  const post: OwnerPostInput = { to: target.seat, body };
  if (target.taskId !== null) post.toTask = target.taskId;
  if (about.startsWith("task:")) post.taskId = about.slice("task:".length);
  else if (about.startsWith("milestone:")) post.milestone = about.slice("milestone:".length);
  else if (target.taskId === null && !planning) return null;
  return post;
}
