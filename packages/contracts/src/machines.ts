import { z } from "zod";
export const MachineStatusSchema = z.enum(["online", "offline", "enrolling", "revoked"]);
export const MachineRoleSchema = z.enum(["hub", "node", "both"]);
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
});
export type Machine = z.infer<typeof MachineSchema>;
export const MachineListSchema = z.object({ machines: z.array(MachineSchema) });
export const EnrollmentCodeSchema = z.object({
  code: z.string(),
  expiresAt: z.string(),
  hubUrl: z.string(),
});
export type EnrollmentCode = z.infer<typeof EnrollmentCodeSchema>;
