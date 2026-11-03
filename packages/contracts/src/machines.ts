import { z } from "zod";
export const MachineStatusSchema = z.enum(["online", "offline", "enrolling", "revoked"]);
export const MachineRoleSchema = z.enum(["hub", "node", "both"]);
/**
 * A machine's health as the Machines page shows it: the engine in its
 * image, and the free space where it keeps its data. From
 * `GET /api/v1/node/health` on that machine.
 */
export const MachineHealthSchema = z.object({
  /** The engine version in the image, from `/etc/aio-engine-version`, or `null` without one. */
  engineVersion: z.string().nullable(),
  /** The engine version the machine's server expects. */
  expectedEngineVersion: z.string(),
  /**
   * `ready`; `missing`, with no image; `mismatch`, when the image's engine
   * differs from the expected one; or `unknown`, when Docker doesn't answer.
   */
  image: z.enum(["ready", "missing", "mismatch", "unknown"]),
  /** Free and total bytes on the file system of the data directory, or `null` when unknown. */
  diskFreeBytes: z.number().nonnegative().nullable(),
  diskTotalBytes: z.number().nonnegative().nullable(),
  /** When the machine measured this. */
  checkedAt: z.string(),
});
export type MachineHealth = z.infer<typeof MachineHealthSchema>;
export const MachineSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: MachineRoleSchema,
  status: MachineStatusSchema,
  isLocal: z.boolean(),
  serverVersion: z.string().nullable(),
  protocol: z.number().int().nullable(),
  capabilities: z.array(z.string()),
  lastSeen: z.string().nullable(),
  platform: z.enum(["linux", "darwin", "win32"]).nullable(),
  /**
   * The machine's last known health, or `null` when the hub hasn't heard it.
   * Missing from servers older than `health.v1`.
   */
  health: MachineHealthSchema.nullable().optional(),
});
export type Machine = z.infer<typeof MachineSchema>;
export const MachineListSchema = z.object({ machines: z.array(MachineSchema) });
export const EnrollmentCodeSchema = z.object({
  code: z.string(),
  expiresAt: z.string(),
  hubUrl: z.string(),
});
export type EnrollmentCode = z.infer<typeof EnrollmentCodeSchema>;
/** A GUI app that enrolled with this hub to control it from another PC. */
export const GuiClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "revoked"]),
  createdAt: z.string(),
  lastSeen: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type GuiClient = z.infer<typeof GuiClientSchema>;
export const GuiClientListSchema = z.object({
  clients: z.array(GuiClientSchema),
  /** The port of the hub's GUI listener, or `null` while it's off. */
  port: z.number().int().nullable(),
});
export type GuiClientList = z.infer<typeof GuiClientListSchema>;
