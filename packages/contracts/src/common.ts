// Primitives that more than one contract module uses.
import { z } from "zod";

/** An ISO 8601 timestamp with a time zone offset, such as `2026-10-28T09:00:00Z`. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** A TCP port number. */
export const PortSchema = z.number().int().min(1).max(65535);

/** A non-negative integer count. */
export const CountSchema = z.number().int().nonnegative();

/** A fraction between 0 and 1, inclusive. */
export const FractionSchema = z.number().min(0).max(1);

/**
 * The CLI that a box's main tmux session runs. The `known/` record omits the
 * `platform` key for `claude`.
 */
export const PlatformSchema = z.enum(["claude", "codex", "copilot"]);
export type Platform = z.infer<typeof PlatformSchema>;

/**
 * A model vendor in the review pipeline. Each vendor maps to one CLI, so the
 * values match `Platform`.
 */
export const VendorSchema = PlatformSchema;
export type Vendor = z.infer<typeof VendorSchema>;

/** The `--effort` values that Claude Code accepts. */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

/** A git commit SHA, abbreviated (7 or more hex digits) or full. */
export const CommitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

/** An environment variable name. */
export const EnvVarNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** The JSON body that every failed API call returns, on the server and the engine. */
export const ApiErrorSchema = z.object({
  error: z.object({
    /** A stable, machine-readable code, such as `box_running` or `op_locked`. */
    code: z.string().min(1),
    /** A sentence for a person to read. */
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** The body of a successful call that has nothing else to return. */
export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;
