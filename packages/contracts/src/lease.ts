// Usage leases. The scheduler and the ceilings live in the server, because
// usage belongs to an account, not a container. Before each model call the
// engine asks for a lease; the server grants it, moves the role to another
// vendor, tells the run to pause, or refuses.
//
// The server is the engine's only client and the engine cannot reach the
// server, so the exchange runs over the existing channels: the engine emits a
// `lease.requested` event on its event stream, and the server answers with
// `POST /api/v1/leases/:leaseId` on the engine (route `engine.leases.respond`).
import { z } from "zod";
import { CountSchema, IsoDateTimeSchema, VendorSchema } from "./common.js";
import { AgentRoleSchema } from "./runs.js";

export const LeaseRequestSchema = z.object({
  /** Unique per engine; the answer refers to it. */
  leaseId: z.string().min(1),
  runId: z.string().min(1),
  vendor: VendorSchema,
  role: AgentRoleSchema,
  estimate: z.object({ tokens: CountSchema }),
});
export type LeaseRequest = z.infer<typeof LeaseRequestSchema>;

export const LeaseResponseSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("granted"),
    leaseId: z.string().min(1),
    /** The vendor to call. It differs from the request's when the server moved the role. */
    vendor: VendorSchema,
    redirectedFrom: VendorSchema.optional(),
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
  }),
]);
export type LeaseResponse = z.infer<typeof LeaseResponseSchema>;
