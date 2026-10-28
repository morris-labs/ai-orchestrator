// The event stream. The engine and the server emit one discriminated union,
// keyed on `type`. Every event carries `id`, `time`, `source`, and `seq`;
// `seq` increases by one per event from one source, so a client that
// reconnects asks for events after the last `seq` it saw.
import { z } from "zod";
import {
  CountSchema,
  FractionSchema,
  IsoDateTimeSchema,
  PortSchema,
  VendorSchema,
} from "./common.js";
import { FindingSchema, VerdictSchema } from "./findings.js";
import { LeaseRequestSchema } from "./lease.js";
import { BoxSchema } from "./records.js";
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
  seq: CountSchema,
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
  /** Share of the window used, from 0 to 1. For a spend window, spend divided by the ceiling. */
  utilization: FractionSchema,
  resetAt: IsoDateTimeSchema.nullable(),
  source: UsageSourceSchema,
  /** For spend windows: money spent so far in the period, in US dollars. */
  spendUsd: z.number().nonnegative().optional(),
});
export type UsageSample = z.infer<typeof UsageSampleSchema>;

export const TokensSchema = z.object({ in: CountSchema, out: CountSchema });

/** A stage, optionally narrowed to one vendor's lane, for data-flow edges. */
export const FlowEndpointSchema = z.object({
  stage: StageSchema,
  vendor: VendorSchema.optional(),
  role: AgentRoleSchema.optional(),
});
export type FlowEndpoint = z.infer<typeof FlowEndpointSchema>;

export const ListenerSchema = z.object({
  port: PortSchema,
  proto: z.enum(["tcp", "tcp6"]),
  /** The process name `ss` reports, when it reports one. */
  process: z.string().optional(),
  /** The box whose tmux session owns the process, when the engine can tell. */
  boxId: z.string().min(1).optional(),
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
  /** Unique; `POST /api/v1/notifications/:id/read` refers to it. */
  notificationId: z.string().min(1),
  kind: NotificationKindSchema,
  title: z.string().min(1),
  body: z.string(),
  runId: z.string().min(1).optional(),
  boxId: z.string().min(1).optional(),
  severity: z.enum(["info", "warning", "error"]),
  read: z.boolean().default(false),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const BoxStatusSchema = z.enum(["running", "starting", "stopping", "stopped", "known"]);
export type BoxStatus = z.infer<typeof BoxStatusSchema>;

export const ContainerStateSchema = z.enum(["created", "running", "exited", "removed"]);
export type ContainerState = z.infer<typeof ContainerStateSchema>;

// ---------------------------------------------------------------------------
// Events

const agentFields = {
  runId: z.string().min(1),
  /** Unique per agent call within the run. */
  agentId: z.string().min(1),
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
  /** Estimated cost in US dollars. */
  costEstimate: z.number().nonnegative(),
});

export const StageChangedEventSchema = z.object({
  ...base,
  type: z.literal("stage.changed"),
  runId: z.string().min(1),
  round: CountSchema,
  stage: StageSchema,
  previousStage: StageSchema.nullable(),
});

export const HandoffEventSchema = z.object({
  ...base,
  type: z.literal("handoff"),
  runId: z.string().min(1),
  round: CountSchema,
  from: FlowEndpointSchema,
  to: FlowEndpointSchema,
  /** The kind of item handed over, such as `findings` or `hunks`. */
  artifact: z.string().min(1),
  count: CountSchema,
  /** The run-directory file that holds the items, relative to the run directory. */
  file: z.string().optional(),
});

export const FindingChangedEventSchema = z.object({
  ...base,
  type: z.literal("finding.changed"),
  runId: z.string().min(1),
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
  utilization: FractionSchema,
  ceiling: FractionSchema,
  direction: z.enum(["above", "below"]),
  resetAt: IsoDateTimeSchema.nullable(),
});

export const RoleReassignedEventSchema = z.object({
  ...base,
  type: z.literal("role.reassigned"),
  runId: z.string().min(1),
  role: RoleSchema,
  from: VendorSchema,
  to: VendorSchema,
  reason: z.enum(["ceiling", "limit", "manual", "overlap", "profile"]),
  /** The first round the change applies to. */
  effectiveRound: CountSchema,
});

export const RunChangedEventSchema = z.object({
  ...base,
  type: z.literal("run.changed"),
  run: RunStateSchema,
  /** Present when the change finished a round. */
  roundSummary: RoundSummarySchema.optional(),
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
  engine: z
    .object({
      /** The host loopback port Docker maps to the engine's 20411. */
      hostPort: PortSchema.optional(),
      version: z.string().optional(),
      healthy: z.boolean(),
      versionMatches: z.boolean().optional(),
    })
    .optional(),
});

export const PortsChangedEventSchema = z.object({
  ...base,
  type: z.literal("ports.changed"),
  container: z.string().min(1),
  /** Set when every listener belongs to one box. */
  boxId: z.string().min(1).optional(),
  listeners: z.array(ListenerSchema),
});

export const TerminalEndedEventSchema = z.object({
  ...base,
  type: z.literal("terminal.ended"),
  terminalId: z.string().min(1),
  boxId: z.string().min(1).optional(),
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

export const LeaseRequestedEventSchema = z.object({
  ...base,
  type: z.literal("lease.requested"),
  ...LeaseRequestSchema.shape,
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
  RunChangedEventSchema,
  BoxChangedEventSchema,
  ContainerChangedEventSchema,
  PortsChangedEventSchema,
  TerminalEndedEventSchema,
  NotificationEventSchema,
  LeaseRequestedEventSchema,
]);
export type AgentBoxEvent = z.infer<typeof EventSchema>;
export type EventType = AgentBoxEvent["type"];
/** The event with the given `type`. */
export type EventOf<T extends EventType> = Extract<AgentBoxEvent, { type: T }>;

/** Every event type, in declaration order. */
export const EVENT_TYPES = EventSchema.options.map(
  (option) => option.shape.type.value,
) as EventType[];
