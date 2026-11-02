// Usage leases. The scheduler and the ceilings live in the server, because
// usage belongs to an account, not a container. Before each model call the
// engine asks for a lease; the server grants it (possibly on another vendor),
// tells the run to pause until a time, or refuses.
//
// The engine cannot reach the server, so leases travel as control frames on
// the engine's event WebSocket (`engine.events`), which the server holds open:
//
// 1. The engine sends a `lease.request` frame. Control frames have no `seq`
//    and are never replayed.
// 2. The server answers with a `lease.response` frame on the same socket.
// 3. Whenever a client subscribes (each new connection, after its `hello`),
//    the engine resends every request that has no answer yet. The server
//    answers a repeated `leaseId` with the same response.
// 4. A grant is valid until its `expiresAt`. When the socket drops, the
//    engine keeps using a grant until then, after which the grant is void and
//    the engine asks again before the next call.
// 5. On `pause`, the engine asks again at `resumeAt`. On `deny`, the engine
//    pauses the run with a decision of kind `ceiling`, or fails the role when
//    `action` is `fail_role`.
// 6. After the call, the engine emits a `lease.settled` event with the actual
//    usage, which the server records against the account.
import { z } from "zod";
import { CountSchema, IsoDateTimeSchema, RunIdSchema, VendorSchema } from "./common.js";
import { AgentRoleSchema } from "./runs.js";

export const LeaseRequestSchema = z.object({
  /** Unique per engine; the response and the settlement refer to it. */
  leaseId: z.string().min(1),
  runId: RunIdSchema,
  vendor: VendorSchema,
  role: AgentRoleSchema,
  estimate: z.object({ tokens: CountSchema }),
  /**
   * Vendors the server must not move the call to: the vendor that did the
   * work under the cross-vendor rule, one that reported a limit in this run,
   * or one with no working CLI. Absent means no restriction.
   */
  exclude: z.array(VendorSchema).optional(),
});
export type LeaseRequest = z.infer<typeof LeaseRequestSchema>;

export const LeaseResponseSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("granted"),
    leaseId: z.string().min(1),
    /** The vendor to call. It differs from the request's when the server moved the role. */
    vendor: VendorSchema,
    /** The requested vendor when the server moved the role; `null` otherwise. */
    redirectedFrom: VendorSchema.nullable(),
    /** The grant is void after this time unless the call has started. */
    expiresAt: IsoDateTimeSchema,
  }),
  z.object({
    decision: z.literal("pause"),
    leaseId: z.string().min(1),
    /** Ask again at this time. */
    resumeAt: IsoDateTimeSchema,
    reason: z.string(),
  }),
  z.object({
    decision: z.literal("deny"),
    leaseId: z.string().min(1),
    reason: z.string(),
    /** `pause`: pause the run with a `ceiling` decision. `fail_role`: fail this role's call. */
    action: z.enum(["pause", "fail_role"]),
  }),
]);
export type LeaseResponse = z.infer<typeof LeaseResponseSchema>;

/** Engine to server: a lease request on `engine.events`. */
export const LeaseRequestFrameSchema = LeaseRequestSchema.extend({
  type: z.literal("lease.request"),
});
export type LeaseRequestFrame = z.infer<typeof LeaseRequestFrameSchema>;

/** Server to engine: the answer to a `lease.request` frame. */
export const LeaseResponseFrameSchema = z.object({
  type: z.literal("lease.response"),
  response: LeaseResponseSchema,
});
export type LeaseResponseFrame = z.infer<typeof LeaseResponseFrameSchema>;

/** The actual usage of a call made under a lease; the payload of `lease.settled`. */
export const LeaseSettlementSchema = z.object({
  leaseId: z.string().min(1),
  runId: RunIdSchema,
  vendor: VendorSchema,
  role: AgentRoleSchema,
  tokens: z.object({ in: CountSchema, out: CountSchema }),
  /** Copilot premium requests; 0 for other vendors. */
  premiumRequests: z.number().nonnegative(),
  /** Estimated cost in US dollars. */
  costEstimate: z.number().nonnegative(),
});
export type LeaseSettlement = z.infer<typeof LeaseSettlementSchema>;
