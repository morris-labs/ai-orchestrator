// The usage watcher's settings. The watcher covers builds and stand-alone
// review runs across the account: it alerts and never pauses anything.
import { z } from "zod";

/** The alert thresholds of one usage window. */
export const UsageWatchWindowSchema = z
  .object({
    /**
     * The share of the window, from 0 to 1, past which the ceiling alert
     * fires, when the burn rate also reaches the whole window before it
     * resets.
     */
    ceilingAt: z.number().min(0).max(1),
    /** The rise, as a share of the window, that counts as an abnormal jump. */
    jump: z.number().positive().max(1),
    /** The span, in minutes, that the jump is measured over. */
    jumpMinutes: z.number().int().positive(),
  })
  .strict();
export type UsageWatchWindow = z.infer<typeof UsageWatchWindowSchema>;

/** The windows the watcher checks. */
export const WATCHED_WINDOWS = ["5h", "7d"] as const;
export type WatchedWindow = (typeof WATCHED_WINDOWS)[number];

export const UsageWatchSchema = z
  .object({
    "5h": UsageWatchWindowSchema,
    "7d": UsageWatchWindowSchema,
    /** The multiple of a build's high usage estimate past which the watcher alerts. */
    buildEstimateFactor: z.number().min(1),
  })
  .strict();
export type UsageWatch = z.infer<typeof UsageWatchSchema>;

/** The thresholds the watcher uses when the settings name none. */
export const DEFAULT_USAGE_WATCH: UsageWatch = {
  "5h": { ceilingAt: 0.8, jump: 0.15, jumpMinutes: 10 },
  "7d": { ceilingAt: 0.8, jump: 0.05, jumpMinutes: 60 },
  buildEstimateFactor: 2,
};

/** The body of a settings patch's `usageWatch`: only the fields it names change. */
export const UsageWatchPatchSchema = z
  .object({
    "5h": UsageWatchWindowSchema.partial().strict(),
    "7d": UsageWatchWindowSchema.partial().strict(),
    buildEstimateFactor: UsageWatchSchema.shape.buildEstimateFactor,
  })
  .partial()
  .strict();
export type UsageWatchPatch = z.infer<typeof UsageWatchPatchSchema>;

/** The watcher's thresholds: the settings' own, else the defaults. */
export function usageWatchOf(settings: { usageWatch?: UsageWatch | undefined }): UsageWatch {
  return settings.usageWatch ?? DEFAULT_USAGE_WATCH;
}

/** Applies a patch to the current thresholds; `null` goes back to the defaults. */
export function patchUsageWatch(
  current: UsageWatch | undefined,
  patch: UsageWatchPatch | null,
): UsageWatch | undefined {
  if (patch === null) return undefined;
  const base = current ?? DEFAULT_USAGE_WATCH;
  return {
    "5h": { ...base["5h"], ...stripUndefined(patch["5h"]) },
    "7d": { ...base["7d"], ...stripUndefined(patch["7d"]) },
    buildEstimateFactor: patch.buildEstimateFactor ?? base.buildEstimateFactor,
  };
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
