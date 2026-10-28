// The dashboard's state, built only from the event stream and the usage
// routes. `applyEvent()` is a pure reducer: it returns a new state for every
// event that changes something, so React can compare by reference.
import type {
  AgentBoxEvent,
  AgentRole,
  BoxStatus,
  ContainerState,
  EngineInfo,
  EventOf,
  Finding,
  FlowEndpoint,
  Listener,
  Notification,
  RoundSummary,
  RunState,
  Stage,
  TimedUsageSample,
  UsageWindow,
  Vendor,
} from "@agentbox/contracts";

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
  startedAt: string;
  finishedAt: string | null;
  outcome: EventOf<"agent.finished">["outcome"] | null;
  elapsedMs: number | null;
  tokens: { in: number; out: number } | null;
  costEstimate: number | null;
}

export interface FlowEdge {
  /** `from` and `to` endpoints joined, so repeated handoffs add up. */
  key: string;
  from: FlowEndpoint;
  to: FlowEndpoint;
  artifact: string;
  /** Items handed over on this edge since the dashboard started. */
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
  /** Where the client is in the stream, for the resume `hello`. */
  cursor: { streamId: string; seq: number } | null;
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
    cursor: null,
    eventCount: 0,
  };
}

/** The key of one usage series: a vendor account's window. */
export function seriesKey(vendor: Vendor, account: string, window: UsageWindow): string {
  return `${vendor}|${account}|${window}`;
}

/** The key of a data-flow edge. */
export function edgeKey(from: FlowEndpoint, to: FlowEndpoint): string {
  const end = (e: FlowEndpoint) => `${e.stage}:${e.vendor ?? "-"}:${e.role ?? "-"}`;
  return `${end(from)}>${end(to)}`;
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

/** Adds samples to their series, in time order, without duplicates. */
export function addUsageSamples(
  state: DashboardState,
  samples: readonly TimedUsageSample[],
): DashboardState {
  if (samples.length === 0) return state;
  const usage = { ...state.usage };
  for (const s of samples) {
    const key = seriesKey(s.vendor, s.account, s.window);
    const series = usage[key] ?? [];
    if (series.some((p) => p.time === s.time)) continue;
    const next = [...series, s].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    usage[key] = next.slice(-USAGE_HISTORY_LIMIT);
  }
  return { ...state, usage };
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

/** Applies one event. Events of other streams or older `seq` values still apply. */
export function applyEvent(prev: DashboardState, event: AgentBoxEvent): DashboardState {
  const state: DashboardState = {
    ...prev,
    cursor: { streamId: event.streamId, seq: event.seq },
    eventCount: prev.eventCount + 1,
  };
  switch (event.type) {
    case "agent.started": {
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
        startedAt: started?.startedAt ?? new Date(Date.parse(event.time) - event.elapsedMs).toISOString(),
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
      const key = edgeKey(event.from, event.to);
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
      // The usage sample's own `source` (where the reading came from) replaces
      // the event's `source` field in this event type, so it passes through.
      const { id: _id, type: _t, streamId: _sid, seq: _seq, sourceSeq: _ss, ...rest } = event;
      return addUsageSamples(state, [rest]);
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
    case "run.changed":
      return withRun(state, event.run.id, (r) => ({
        ...r,
        run: event.run,
        stage: event.run.stage,
        round: event.run.round,
        rounds: event.roundSummary ? upsertRound(r.rounds, event.roundSummary) : r.rounds,
      }));
    case "box.changed":
      if (event.box === null) {
        const { [event.boxId]: _gone, ...boxes } = state.boxes;
        return { ...state, boxes };
      }
      return { ...state, boxes: { ...state.boxes, [event.boxId]: event.status } };
    case "container.changed": {
      const c = container(state, event.container, event.projectId, event.time);
      if (event.state === "removed") {
        const { [event.container]: _gone, ...containers } = state.containers;
        return { ...state, containers };
      }
      return {
        ...state,
        containers: {
          ...state.containers,
          [event.container]: { ...c, state: event.state, engine: event.engine, updatedAt: event.time },
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
        containers: { ...state.containers, [event.container]: { ...c, listeners: event.listeners } },
      };
    }
    case "terminal.ended":
      return event.unexpected ? { ...state, unexpectedEnds: state.unexpectedEnds + 1 } : state;
    case "notification": {
      const { id: _id, type: _t, time: _time, source: _s, streamId: _sid, seq: _q, sourceSeq: _ss, ...n } =
        event;
      const rest = state.notifications.filter((x) => x.notificationId !== n.notificationId);
      return { ...state, notifications: [...rest, n].slice(-NOTIFICATION_LIMIT) };
    }
    case "settings.changed":
      return { ...state, settingsChangedAt: event.time };
  }
}

/** Applies events in order. */
export function replay(events: readonly AgentBoxEvent[], start = emptyDashboard()): DashboardState {
  return events.reduce(applyEvent, start);
}
