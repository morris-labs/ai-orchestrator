// The dashboard's state, built from a REST snapshot (`seedDashboard()`), the
// event stream, and the usage routes. `applyEvent()` is a pure reducer: it
// returns a new state for every event that changes something, so React can
// compare by reference.
import type {
  AioEvent,
  AgentRole,
  BoxStatus,
  BoxView,
  ContainerState,
  EngineInfo,
  EventOf,
  Finding,
  FlowEndpoint,
  Listener,
  Notification,
  ProjectSummary,
  RoundSummary,
  RunState,
  RunStatus,
  Stage,
  TimedUsageSample,
  UsageWindow,
  Vendor,
} from "@aio/contracts";

export interface ContainerView {
  name: string;
  projectId: string;
  /** `null` until a `container.changed` event names it. */
  state: ContainerState | null;
  engine: EngineInfo | null;
  cpuPercent: number | null;
  memBytes: number | null;
  memLimitBytes: number | null;
  diskBytes: number | null;
  listeners: Listener[];
  updatedAt: string;
}

export interface AgentView {
  agentId: string;
  runId: string;
  vendor: Vendor;
  model: string;
  role: AgentRole;
  groupId: string | null;
  round: number;
  /** The reasoning effort the call asked for. Absent means the vendor's own default. */
  effort?: string;
  startedAt: string;
  finishedAt: string | null;
  /** Set when a lost engine, not `agent.finished`, ended the agent. */
  endedByEngine?: boolean;
  outcome: EventOf<"agent.finished">["outcome"] | null;
  elapsedMs: number | null;
  tokens: { in: number; out: number } | null;
  costEstimate: number | null;
}

export interface FlowEdge {
  /** The run and the `from` and `to` endpoints joined, so repeated handoffs of one run add up. */
  key: string;
  from: FlowEndpoint;
  to: FlowEndpoint;
  artifact: string;
  /** Items handed over on this edge in this run since the dashboard started. */
  total: number;
  /** Items in the most recent handoff. */
  last: number;
  lastAt: string;
  /** Id of the most recent handoff event; a change restarts the animation. */
  lastEventId: string;
  runId: string;
  round: number;
}

export interface RunView {
  runId: string;
  /** `null` until a `run.changed` event carries the full state. */
  run: RunState | null;
  stage: Stage | null;
  round: number;
  rounds: RoundSummary[];
  findings: Record<string, Finding>;
  reassignments: Array<EventOf<"role.reassigned">>;
  /** Cost settled through leases, by round, from `agent.finished` and `lease.settled`. */
  liveCostByRound: Record<number, number>;
}

export interface CeilingState {
  vendor: Vendor;
  account: string;
  window: UsageWindow;
  above: boolean;
  utilization: number;
  resetAt: string | null;
  time: string;
}

export interface DashboardState {
  containers: Record<string, ContainerView>;
  runs: Record<string, RunView>;
  /** Keyed `<runId>/<agentId>`. */
  agents: Record<string, AgentView>;
  flows: Record<string, FlowEdge>;
  /** Usage samples keyed by `seriesKey()`, oldest first. */
  usage: Record<string, TimedUsageSample[]>;
  ceilings: Record<string, CeilingState>;
  boxes: Record<string, BoxStatus>;
  notifications: Notification[];
  /** Terminals that ended without a person asking, newest last. */
  unexpectedEnds: number;
  settingsChangedAt: string | null;
  eventCount: number;
}

export function emptyDashboard(): DashboardState {
  return {
    containers: {},
    runs: {},
    agents: {},
    flows: {},
    usage: {},
    ceilings: {},
    boxes: {},
    notifications: [],
    unexpectedEnds: 0,
    settingsChangedAt: null,
    eventCount: 0,
  };
}

/** The key of one usage series: a vendor account's window. */
export function seriesKey(vendor: Vendor, account: string, window: UsageWindow): string {
  return `${vendor}|${account}|${window}`;
}

/** The key of a data-flow edge between two endpoints, without the run. */
export function edgeKey(from: FlowEndpoint, to: FlowEndpoint): string {
  const end = (e: FlowEndpoint) => `${e.stage}:${e.vendor ?? "-"}:${e.role ?? "-"}`;
  return `${end(from)}>${end(to)}`;
}

/** The key of a data-flow edge in one run: edges of different runs never share a count. */
export function runEdgeKey(runId: string, from: FlowEndpoint, to: FlowEndpoint): string {
  return `${runId}|${edgeKey(from, to)}`;
}

/** Usage history kept per series; older samples drop off. */
export const USAGE_HISTORY_LIMIT = 2000;
const NOTIFICATION_LIMIT = 200;

function container(state: DashboardState, name: string, projectId: string, time: string) {
  return (
    state.containers[name] ?? {
      name,
      projectId,
      state: null,
      engine: null,
      cpuPercent: null,
      memBytes: null,
      memLimitBytes: null,
      diskBytes: null,
      listeners: [],
      updatedAt: time,
    }
  );
}

function runView(state: DashboardState, runId: string): RunView {
  return (
    state.runs[runId] ?? {
      runId,
      run: null,
      stage: null,
      round: 0,
      rounds: [],
      findings: {},
      reassignments: [],
      liveCostByRound: {},
    }
  );
}

function withRun(state: DashboardState, runId: string, f: (r: RunView) => RunView): DashboardState {
  return { ...state, runs: { ...state.runs, [runId]: f(runView(state, runId)) } };
}

/** Adds a round summary, replacing an earlier one for the same round. */
export function upsertRound(rounds: RoundSummary[], summary: RoundSummary): RoundSummary[] {
  return [...rounds.filter((r) => r.round !== summary.round), summary].sort(
    (a, b) => a.round - b.round,
  );
}

/**
 * Adds samples to their series, in time order, without duplicates. Each
 * touched series is merged and sorted once, so a large history loads in
 * O(n log n).
 */
export function addUsageSamples(
  state: DashboardState,
  samples: readonly TimedUsageSample[],
): DashboardState {
  if (samples.length === 0) return state;
  const incoming = new Map<string, TimedUsageSample[]>();
  for (const s of samples) {
    const key = seriesKey(s.vendor, s.account, s.window);
    const list = incoming.get(key);
    if (list) list.push(s);
    else incoming.set(key, [s]);
  }
  const usage = { ...state.usage };
  let changed = false;
  for (const [key, added] of incoming) {
    const series = usage[key] ?? [];
    const times = new Set(series.map((p) => p.time));
    const fresh: TimedUsageSample[] = [];
    for (const s of added) {
      if (times.has(s.time)) continue;
      times.add(s.time);
      fresh.push(s);
    }
    if (fresh.length === 0) continue;
    changed = true;
    const last = series[series.length - 1];
    const inOrder =
      fresh.every((s, i) => i === 0 || Date.parse(fresh[i - 1]!.time) <= Date.parse(s.time)) &&
      (last === undefined || Date.parse(last.time) <= Date.parse(fresh[0]!.time));
    const next = inOrder
      ? [...series, ...fresh]
      : [...series, ...fresh]
          .map((s) => ({ s, t: Date.parse(s.time) }))
          .sort((a, b) => a.t - b.t)
          .map((x) => x.s);
    usage[key] = next.length > USAGE_HISTORY_LIMIT ? next.slice(-USAGE_HISTORY_LIMIT) : next;
  }
  return changed ? { ...state, usage } : state;
}

function agentKey(runId: string, agentId: string) {
  return `${runId}/${agentId}`;
}

function addCost(r: RunView, round: number, cost: number): RunView {
  return {
    ...r,
    liveCostByRound: { ...r.liveCostByRound, [round]: (r.liveCostByRound[round] ?? 0) + cost },
  };
}

/** Finished runs the dashboard keeps, with their agents and flows; older ones drop off. */
export const CLOSED_RUN_LIMIT = 50;

function isOpen(status: RunStatus): boolean {
  return OPEN_RUN_STATUSES.includes(status);
}

/**
 * Marks the agents of the runs that `ends` picks as ended at `time`. An
 * agent that never reported `agent.finished`, because its run ended or its
 * engine went away, would otherwise count as running forever. The outcome
 * stays `null`; a later `agent.finished` still replaces the row.
 */
function endAgents(
  state: DashboardState,
  ends: (runId: string) => boolean,
  time: string,
  byEngine = false,
): DashboardState {
  let agents: Record<string, AgentView> | null = null;
  for (const [key, a] of Object.entries(state.agents)) {
    if (a.finishedAt !== null || !ends(a.runId)) continue;
    agents ??= { ...state.agents };
    agents[key] = { ...a, finishedAt: time, ...(byEngine ? { endedByEngine: true } : {}) };
  }
  return agents ? { ...state, agents } : state;
}

/** Reopens the agents of a project's open runs that a lost engine ended. */
function reopenAgents(state: DashboardState, projectId: string): DashboardState {
  let agents: Record<string, AgentView> | null = null;
  for (const [key, a] of Object.entries(state.agents)) {
    const run = state.runs[a.runId]?.run;
    if (!a.endedByEngine || !run || run.request.projectId !== projectId || !isOpen(run.status))
      continue;
    const { endedByEngine: _ended, ...open } = a;
    agents ??= { ...state.agents };
    agents[key] = { ...open, finishedAt: null };
  }
  return agents ? { ...state, agents } : state;
}

/**
 * Keeps the newest `CLOSED_RUN_LIMIT` finished runs and drops older ones with
 * their agents and flows, so a long-running app's maps stay bounded. Open runs
 * and runs whose state isn't known yet always stay.
 */
function pruneRuns(state: DashboardState): DashboardState {
  const closed = Object.values(state.runs)
    .filter((r) => r.run !== null && !isOpen(r.run.status))
    .sort((a, b) => Date.parse(b.run!.updatedAt) - Date.parse(a.run!.updatedAt));
  if (closed.length <= CLOSED_RUN_LIMIT) return state;
  const drop = new Set(closed.slice(CLOSED_RUN_LIMIT).map((r) => r.runId));
  const keep = <T>(m: Record<string, T>, runOf: (v: T) => string) =>
    Object.fromEntries(Object.entries(m).filter(([, v]) => !drop.has(runOf(v))));
  return {
    ...state,
    runs: keep(state.runs, (r) => r.runId),
    agents: keep(state.agents, (a) => a.runId),
    flows: keep(state.flows, (f) => f.runId),
  };
}

/** Applies one event. Events of other streams or older `seq` values still apply. */
export function applyEvent(prev: DashboardState, event: AioEvent): DashboardState {
  const state: DashboardState = {
    ...prev,
    eventCount: prev.eventCount + 1,
  };
  switch (event.type) {
    case "agent.started": {
      // A build's own calls belong to no review run.
      if (event.runId === null) return state;
      const key = agentKey(event.runId, event.agentId);
      return {
        ...state,
        agents: {
          ...state.agents,
          [key]: {
            agentId: event.agentId,
            runId: event.runId,
            vendor: event.vendor,
            model: event.model,
            role: event.role,
            groupId: event.groupId,
            round: event.round,
            ...(event.effort ? { effort: event.effort } : {}),
            startedAt: event.time,
            finishedAt: null,
            outcome: null,
            elapsedMs: null,
            tokens: null,
            costEstimate: null,
          },
        },
      };
    }
    case "agent.finished": {
      if (event.runId === null) return state;
      const key = agentKey(event.runId, event.agentId);
      const started = state.agents[key];
      const agent: AgentView = {
        agentId: event.agentId,
        runId: event.runId,
        vendor: event.vendor,
        model: event.model,
        role: event.role,
        groupId: event.groupId,
        round: event.round,
        startedAt:
          started?.startedAt ?? new Date(Date.parse(event.time) - event.elapsedMs).toISOString(),
        finishedAt: event.time,
        outcome: event.outcome,
        elapsedMs: event.elapsedMs,
        tokens: event.tokens,
        costEstimate: event.costEstimate,
      };
      const next = { ...state, agents: { ...state.agents, [key]: agent } };
      return withRun(next, event.runId, (r) => addCost(r, event.round, event.costEstimate));
    }
    case "stage.changed":
      return withRun(state, event.runId, (r) => ({
        ...r,
        stage: event.stage,
        round: event.round,
        run: r.run ? { ...r.run, stage: event.stage, round: event.round } : null,
      }));
    case "handoff": {
      const key = runEdgeKey(event.runId, event.from, event.to);
      const old = state.flows[key];
      return {
        ...state,
        flows: {
          ...state.flows,
          [key]: {
            key,
            from: event.from,
            to: event.to,
            artifact: event.artifact,
            total: (old?.total ?? 0) + event.count,
            last: event.count,
            lastAt: event.time,
            lastEventId: event.id,
            runId: event.runId,
            round: event.round,
          },
        },
      };
    }
    case "finding.changed":
      return withRun(state, event.runId, (r) => ({
        ...r,
        findings: { ...r.findings, [event.finding.id]: event.finding },
      }));
    case "usage.sample": {
      // The event's `source` is the stream source; the reading's own origin
      // is `sampleSource`. Copy the sample fields by name so that no
      // envelope field reaches the series.
      const { vendor, account, window, utilization, spendUsd, ceiling, resetAt, sampleSource } =
        event;
      return addUsageSamples(state, [
        {
          vendor,
          account,
          window,
          utilization,
          spendUsd,
          ceiling,
          resetAt,
          sampleSource,
          time: event.time,
        },
      ]);
    }
    case "ceiling.crossed": {
      const key = seriesKey(event.vendor, event.account, event.window);
      return {
        ...state,
        ceilings: {
          ...state.ceilings,
          [key]: {
            vendor: event.vendor,
            account: event.account,
            window: event.window,
            above: event.direction === "above",
            utilization: event.utilization,
            resetAt: event.resetAt,
            time: event.time,
          },
        },
      };
    }
    case "role.reassigned":
      return withRun(state, event.runId, (r) => ({
        ...r,
        reassignments: [...r.reassignments, event],
      }));
    case "lease.settled":
      // `agent.finished` already carries the call's cost; a settlement only
      // confirms it, so the dashboard counts it once.
      return state;
    case "run.changed": {
      const next = withRun(state, event.run.id, (r) => ({
        ...r,
        run: event.run,
        stage: event.run.stage,
        round: event.run.round,
        rounds: event.roundSummary ? upsertRound(r.rounds, event.roundSummary) : r.rounds,
      }));
      if (isOpen(event.run.status)) return next;
      return pruneRuns(endAgents(next, (id) => id === event.run.id, event.time));
    }
    case "box.changed":
      if (event.box === null) {
        const { [event.boxId]: _gone, ...boxes } = state.boxes;
        return { ...state, boxes };
      }
      return { ...state, boxes: { ...state.boxes, [event.boxId]: event.status } };
    case "container.changed": {
      const c = container(state, event.container, event.projectId, event.time);
      // Without a running, healthy engine, the project's agents have stopped
      // reporting. A crashed engine never sends their `agent.finished`. An
      // engine that comes back reopens them, since a blip doesn't end a call.
      const engineGone =
        event.state !== "running" || event.engine === null || !event.engine.healthy;
      const ended = engineGone
        ? endAgents(
            state,
            (id) => state.runs[id]?.run?.request.projectId === event.projectId,
            event.time,
            true,
          )
        : reopenAgents(state, event.projectId);
      if (event.state === "removed") {
        const { [event.container]: _gone, ...containers } = ended.containers;
        return { ...ended, containers };
      }
      return {
        ...ended,
        containers: {
          ...state.containers,
          [event.container]: {
            ...c,
            state: event.state,
            engine: event.engine,
            updatedAt: event.time,
          },
        },
      };
    }
    case "container.stats": {
      const c = container(state, event.container, event.projectId, event.time);
      return {
        ...state,
        containers: {
          ...state.containers,
          [event.container]: {
            ...c,
            cpuPercent: event.cpuPercent,
            memBytes: event.memBytes,
            memLimitBytes: event.memLimitBytes,
            diskBytes: event.diskBytes,
            updatedAt: event.time,
          },
        },
      };
    }
    case "ports.changed": {
      const c = state.containers[event.container];
      if (!c) return state;
      return {
        ...state,
        containers: {
          ...state.containers,
          [event.container]: { ...c, listeners: event.listeners },
        },
      };
    }
    case "terminal.ended":
      return event.unexpected ? { ...state, unexpectedEnds: state.unexpectedEnds + 1 } : state;
    case "notification": {
      const {
        id: _id,
        type: _t,
        time: _time,
        source: _s,
        streamId: _sid,
        seq: _q,
        sourceSeq: _ss,
        ...n
      } = event;
      const rest = state.notifications.filter((x) => x.notificationId !== n.notificationId);
      return { ...state, notifications: [...rest, n].slice(-NOTIFICATION_LIMIT) };
    }
    case "settings.changed":
      return { ...state, settingsChangedAt: event.time };
    case "build.changed":
    case "build.task.changed":
    case "message.sent":
    case "build.inbox":
      // The review dashboard shows review runs; builds have their own view.
      return state;
  }
}

/** Runs whose rounds and findings a snapshot loads: those that can still change. */
export const OPEN_RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "paused",
  "waiting_decision",
];

/** What `seedDashboard()` takes from the REST routes. */
export interface DashboardSnapshot {
  /** From `runs.list`. */
  runs: readonly RunState[];
  /** From `runs.rounds`, by run id. */
  rounds?: Readonly<Record<string, readonly RoundSummary[]>>;
  /** From `findings.list`, by run id. */
  findings?: Readonly<Record<string, readonly Finding[]>>;
  /** From `projects.list`: each project's container. */
  projects?: readonly ProjectSummary[];
  /** From `boxes.list`. */
  boxes?: readonly BoxView[];
  /** When the snapshot was taken; the containers' `updatedAt`. */
  time?: string;
  /**
   * Box ids and container names that events removed while the snapshot
   * loaded. The snapshot may predate the removal, so it can't bring them back.
   */
  removed?: { boxes?: ReadonlySet<string>; containers?: ReadonlySet<string> };
}

/**
 * Fills the state from a REST snapshot, as the event contract asks after a
 * `hello` that can't replay. Events applied while the snapshot loaded are
 * newer, so they win: a run, container, box, round, or finding the state
 * already has keeps its value, and one an event removed stays removed.
 */
export function seedDashboard(state: DashboardState, snap: DashboardSnapshot): DashboardState {
  const runs = { ...state.runs };
  for (const run of snap.runs) {
    const r = runView(state, run.id);
    const rounds = snap.rounds?.[run.id] ?? [];
    const known = new Set(r.rounds.map((x) => x.round));
    const findings = { ...r.findings };
    for (const f of snap.findings?.[run.id] ?? []) findings[f.id] ??= f;
    // A `run.changed` or `stage.changed` event already applied is newer.
    const newer = r.run !== null || r.stage !== null;
    runs[run.id] = {
      ...r,
      run: r.run ?? run,
      stage: newer ? r.stage : run.stage,
      round: newer ? r.round : run.round,
      rounds: rounds
        .filter((x) => !known.has(x.round))
        .reduce((acc, x) => upsertRound(acc, x), r.rounds),
      findings,
    };
  }
  const containers = { ...state.containers };
  for (const p of snap.projects ?? []) {
    const c = p.container;
    if (!c || containers[c.name] || c.state === "removed") continue;
    if (snap.removed?.containers?.has(c.name)) continue;
    containers[c.name] = {
      ...container(state, c.name, p.project.id, snap.time ?? new Date().toISOString()),
      state: c.state,
      engine: c.engine,
    };
  }
  const boxes = { ...state.boxes };
  for (const b of snap.boxes ?? []) {
    if (!snap.removed?.boxes?.has(b.box.id)) boxes[b.box.id] ??= b.status;
  }
  // Agents of a run that ended while the stream was away never finish otherwise.
  const seeded = endAgents(
    { ...state, runs, containers, boxes },
    (id) => {
      const run = runs[id]?.run;
      return run !== null && run !== undefined && !isOpen(run.status);
    },
    snap.time ?? new Date().toISOString(),
  );
  return pruneRuns(seeded);
}

/** Applies events in order. */
export function replay(events: readonly AioEvent[], start = emptyDashboard()): DashboardState {
  return events.reduce(applyEvent, start);
}
