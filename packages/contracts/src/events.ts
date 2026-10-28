// The event stream. The engine and the server emit one discriminated union,
// keyed on `type`, over a WebSocket (`engine.events` and `events.stream`).
//
// Sequence numbers have one definition:
//
// - `streamId` names one run of a stream's producer. It changes when the
//   producer restarts or loses its event log.
// - `seq` is the event's position in the stream you are reading, starting
//   at 1 and increasing by 1, within one `streamId`.
// - `sourceSeq` is the event's `seq` in the stream that first emitted it. On
//   an engine's stream it equals `seq`. On the server's stream, the server
//   re-numbers `seq` and keeps the engine's number in `sourceSeq`; for
//   events the server emits itself, `sourceSeq` equals `seq`.
//
// Each socket opens with a `hello` frame from each side. The client's
// `hello` names the `streamId` and the last `seq` it saw. When the producer's
// `streamId` matches, it replays every later event; otherwise it replays
// nothing, and the client must reload its state through the REST routes
// before it uses further events. Control frames (`hello`, `lease.request`,
// `lease.response`) carry no `seq` and are never replayed.
//
// Event payloads use `null`, not absent fields, for missing values.
import { z } from "zod";
import { CountSchema, IsoDateTimeSchema, PortSchema, RunIdSchema, VendorSchema } from "./common.js";
import { FindingSchema, VerdictSchema } from "./findings.js";
import {
  LeaseRequestFrameSchema,
  LeaseResponseFrameSchema,
  LeaseSettlementSchema,
} from "./lease.js";
import { BoxSchema, CeilingSchema, GlobalSettingsSchema } from "./records.js";
import {
  AgentRoleSchema,
  RoleSchema,
  RoundSummarySchema,
  RunStateSchema,
  StageSchema,
} from "./runs.js";

/** `server`, or `engine:<container name>` for an engine. */
export const EventSourceSchema = z.string().regex(/^(server|engine:.+)$/);
export type EventSource = z.infer<typeof EventSourceSchema>;

const base = {
  id: z.string().min(1),
  time: IsoDateTimeSchema,
  source: EventSourceSchema,
  streamId: z.string().min(1),
  seq: z.number().int().positive(),
  sourceSeq: z.number().int().positive(),
};

// ---------------------------------------------------------------------------
// Payload parts that other modules also use

export const UsageWindowSchema = z.enum(["5h", "7d", "month"]);
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** Where a usage sample came from. */
export const UsageSourceSchema = z.enum([
  "rate_limit_event",
  "codex_session",
  "codex_tokens",
  "billing_api",
  "estimate",
]);
export type UsageSource = z.infer<typeof UsageSourceSchema>;

/** One reading of an account's usage in one window. */
export const UsageSampleSchema = z.object({
  vendor: VendorSchema,
  /** The account the usage belongs to, such as an email address or login. */
  account: z.string().min(1),
  window: UsageWindowSchema,
  /**
   * Share of the window used: 1 means the vendor's limit. For a spend
   * window, `spendUsd` divided by the ceiling's `maxUsd`. Can exceed 1.
   */
  utilization: z.number().nonnegative(),
  /** For a spend window, money spent so far in the period in US dollars; `null` otherwise. */
  spendUsd: z.number().nonnegative().nullable(),
  /** The ceiling in force for this vendor when the sample was taken. */
  ceiling: CeilingSchema,
  resetAt: IsoDateTimeSchema.nullable(),
  /**
   * Where the reading came from. Named `sampleSource` so that the
   * `usage.sample` event, which spreads these fields, keeps `source` for the
   * stream source.
   */
  sampleSource: UsageSourceSchema,
});
export type UsageSample = z.infer<typeof UsageSampleSchema>;

export const TokensSchema = z.object({ in: CountSchema, out: CountSchema });

/** A stage, optionally narrowed to one vendor's lane, for data-flow edges. */
export const FlowEndpointSchema = z.object({
  stage: StageSchema,
  vendor: VendorSchema.nullable(),
  role: AgentRoleSchema.nullable(),
});
export type FlowEndpoint = z.infer<typeof FlowEndpointSchema>;

export const ListenerSchema = z.object({
  port: PortSchema,
  proto: z.enum(["tcp", "tcp6"]),
  /** The process name `ss` reports, or `null`. */
  process: z.string().nullable(),
  /** The box whose tmux session owns the process, or `null` when the engine can't tell. */
  boxId: z.string().min(1).nullable(),
});
export type Listener = z.infer<typeof ListenerSchema>;

export const NotificationKindSchema = z.enum([
  "decision_needed",
  "run_finished",
  "ready_to_push",
  "box_ended",
  "round_summary",
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationSchema = z.object({
  /** Unique; `POST /api/v1/notifications/:notificationId/read` refers to it. */
  notificationId: z.string().min(1),
  kind: NotificationKindSchema,
  title: z.string().min(1),
  body: z.string(),
  runId: RunIdSchema.nullable(),
  boxId: z.string().min(1).nullable(),
  severity: z.enum(["info", "warning", "error"]),
  read: z.boolean(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/**
 * A box's state. `stopped` means its tmux session is not live, whatever the
 * container is doing; `starting` and `stopping` are the server's transitions.
 */
export const BoxStatusSchema = z.enum(["running", "starting", "stopping", "stopped"]);
export type BoxStatus = z.infer<typeof BoxStatusSchema>;

export const ContainerStateSchema = z.enum(["created", "running", "exited", "removed"]);
export type ContainerState = z.infer<typeof ContainerStateSchema>;

/** The engine inside a project container, as the server sees it. */
export const EngineInfoSchema = z.object({
  /** The host loopback port Docker maps to the engine's 20411. */
  hostPort: PortSchema.nullable(),
  /** From the engine's health route; `null` until it answers. */
  version: z.string().nullable(),
  healthy: z.boolean(),
  /** Whether `version` equals the server's expected version; `null` until known. */
  versionMatches: z.boolean().nullable(),
});
export type EngineInfo = z.infer<typeof EngineInfoSchema>;

// ---------------------------------------------------------------------------
// Events

const agentFields = {
  runId: RunIdSchema,
  /** Unique per agent call within the run. */
  agentId: z.string().min(1),
  /** The lease the call runs under. */
  leaseId: z.string().min(1),
  vendor: VendorSchema,
  model: z.string().min(1),
  role: AgentRoleSchema,
  /** `null` for calls that span groups, such as a Copilot whole-diff review. */
  groupId: z.string().min(1).nullable(),
  round: CountSchema,
};

export const AgentStartedEventSchema = z.object({
  ...base,
  type: z.literal("agent.started"),
  ...agentFields,
});

export const AgentFinishedEventSchema = z.object({
  ...base,
  type: z.literal("agent.finished"),
  ...agentFields,
  outcome: z.enum(["ok", "error", "timeout", "limited", "cancelled"]),
  elapsedMs: CountSchema,
  tokens: TokensSchema,
  /** Copilot premium requests; 0 for other vendors. */
  premiumRequests: z.number().nonnegative(),
  /** Copilot AI credits, when the CLI reports them; absent otherwise. */
  aiCredits: z.number().nonnegative().optional(),
  /** Estimated cost in US dollars. */
  costEstimate: z.number().nonnegative(),
});

export const StageChangedEventSchema = z.object({
  ...base,
  type: z.literal("stage.changed"),
  runId: RunIdSchema,
  round: CountSchema,
  stage: StageSchema,
  previousStage: StageSchema.nullable(),
});

export const HandoffEventSchema = z.object({
  ...base,
  type: z.literal("handoff"),
  runId: RunIdSchema,
  round: CountSchema,
  from: FlowEndpointSchema,
  to: FlowEndpointSchema,
  /** The kind of item handed over, such as `findings` or `hunks`. */
  artifact: z.string().min(1),
  count: CountSchema,
  /** The run-directory file that holds the items, relative to the run directory, or `null`. */
  file: z.string().nullable(),
});

export const FindingChangedEventSchema = z.object({
  ...base,
  type: z.literal("finding.changed"),
  runId: RunIdSchema,
  finding: FindingSchema,
  previousVerdict: VerdictSchema.nullable(),
});

export const UsageSampleEventSchema = z.object({
  ...base,
  type: z.literal("usage.sample"),
  ...UsageSampleSchema.shape,
});

export const CeilingCrossedEventSchema = z.object({
  ...base,
  type: z.literal("ceiling.crossed"),
  vendor: VendorSchema,
  account: z.string().min(1),
  window: UsageWindowSchema,
  utilization: z.number().nonnegative(),
  ceiling: CeilingSchema,
  direction: z.enum(["above", "below"]),
  resetAt: IsoDateTimeSchema.nullable(),
});

export const RoleReassignedEventSchema = z.object({
  ...base,
  type: z.literal("role.reassigned"),
  runId: RunIdSchema,
  role: RoleSchema,
  from: z.array(VendorSchema).min(1),
  to: z.array(VendorSchema).min(1),
  reason: z.enum(["ceiling", "limit", "manual", "overlap", "profile"]),
  /** The first round the change applies to. */
  effectiveRound: CountSchema,
});

export const LeaseSettledEventSchema = z.object({
  ...base,
  type: z.literal("lease.settled"),
  ...LeaseSettlementSchema.shape,
});

export const RunChangedEventSchema = z.object({
  ...base,
  type: z.literal("run.changed"),
  run: RunStateSchema,
  /** Set when the change finished a round; `null` otherwise. */
  roundSummary: RoundSummarySchema.nullable(),
});

export const BoxChangedEventSchema = z.object({
  ...base,
  type: z.literal("box.changed"),
  boxId: z.string().min(1),
  status: BoxStatusSchema,
  /** The record after the change; `null` when the box was removed. */
  box: BoxSchema.nullable(),
});

export const ContainerChangedEventSchema = z.object({
  ...base,
  type: z.literal("container.changed"),
  container: z.string().min(1),
  projectId: z.string().min(1),
  state: ContainerStateSchema,
  engine: EngineInfoSchema.nullable(),
});

export const ContainerStatsEventSchema = z.object({
  ...base,
  type: z.literal("container.stats"),
  container: z.string().min(1),
  projectId: z.string().min(1),
  cpuPercent: z.number().nonnegative(),
  /** Memory in use, excluding the inactive file cache. */
  memBytes: CountSchema,
  memLimitBytes: CountSchema,
  /** Size of the container's writable layer. */
  diskBytes: CountSchema,
});

export const PortsChangedEventSchema = z.object({
  ...base,
  type: z.literal("ports.changed"),
  container: z.string().min(1),
  /** The full list of listeners in the container after the change. */
  listeners: z.array(ListenerSchema),
});

export const TerminalEndedEventSchema = z.object({
  ...base,
  type: z.literal("terminal.ended"),
  terminalId: z.string().min(1),
  boxId: z.string().min(1).nullable(),
  kind: z.enum(["session", "side", "shell", "job"]),
  exitCode: z.number().int().nullable(),
  /** True when the session ended without a person asking it to. */
  unexpected: z.boolean(),
});

export const NotificationEventSchema = z.object({
  ...base,
  type: z.literal("notification"),
  ...NotificationSchema.shape,
});

export const SettingsChangedEventSchema = z.object({
  ...base,
  type: z.literal("settings.changed"),
  settings: GlobalSettingsSchema,
  /** Top-level keys of `GlobalSettings` that changed. */
  changedKeys: z.array(z.string().min(1)),
});

export const EventSchema = z.discriminatedUnion("type", [
  AgentStartedEventSchema,
  AgentFinishedEventSchema,
  StageChangedEventSchema,
  HandoffEventSchema,
  FindingChangedEventSchema,
  UsageSampleEventSchema,
  CeilingCrossedEventSchema,
  RoleReassignedEventSchema,
  LeaseSettledEventSchema,
  RunChangedEventSchema,
  BoxChangedEventSchema,
  ContainerChangedEventSchema,
  ContainerStatsEventSchema,
  PortsChangedEventSchema,
  TerminalEndedEventSchema,
  NotificationEventSchema,
  SettingsChangedEventSchema,
]);
export type AgentBoxEvent = z.infer<typeof EventSchema>;
export type EventType = AgentBoxEvent["type"];
/** The event with the given `type`. */
export type EventOf<T extends EventType> = Extract<AgentBoxEvent, { type: T }>;

/** Every event type, in declaration order. */
export const EVENT_TYPES = EventSchema.options.map(
  (option) => option.shape.type.value,
) as EventType[];

// ---------------------------------------------------------------------------
// Stream frames

/** The producer's first frame on a stream. */
export const StreamHelloSchema = z.object({
  type: z.literal("hello"),
  streamId: z.string().min(1),
  /** The `seq` of the newest event in the stream; 0 when there is none. */
  lastSeq: CountSchema,
  /** True when the client's `streamId` matched and later events follow as replay. */
  replaying: z.boolean(),
});
export type StreamHello = z.infer<typeof StreamHelloSchema>;

/** The client's first frame on a stream; it can send another one to resync. */
export const ClientHelloSchema = z.object({
  type: z.literal("hello"),
  /** The `streamId` the client last saw, or `null` on a first connection. */
  streamId: z.string().min(1).nullable(),
  /** The last `seq` the client saw in that stream, or `null`. */
  lastSeq: CountSchema.nullable(),
});
export type ClientHello = z.infer<typeof ClientHelloSchema>;

/** Frames the server sends on `events.stream`. */
export const ServerStreamFrameSchema = z.discriminatedUnion("type", [
  StreamHelloSchema,
  ...EventSchema.options,
]);
export type ServerStreamFrame = z.infer<typeof ServerStreamFrameSchema>;

/** Frames the engine sends on `engine.events`. */
export const EngineStreamFrameSchema = z.discriminatedUnion("type", [
  StreamHelloSchema,
  LeaseRequestFrameSchema,
  ...EventSchema.options,
]);
export type EngineStreamFrame = z.infer<typeof EngineStreamFrameSchema>;

/** Frames the server sends to the engine on `engine.events`. */
export const EngineStreamClientFrameSchema = z.discriminatedUnion("type", [
  ClientHelloSchema,
  LeaseResponseFrameSchema,
]);
export type EngineStreamClientFrame = z.infer<typeof EngineStreamClientFrameSchema>;
