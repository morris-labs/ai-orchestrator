// Builds the settings PATCH body from the edited values: only what changed.
import {
  GlobalSettingsPatchSchema,
  type Ceiling,
  type GlobalSettings,
  type GlobalSettingsPatch,
  type NotificationToggles,
  type Vendor,
} from "@agentbox/contracts";

export interface SettingsDraft {
  ceilings: Record<Vendor, Ceiling>;
  notifications: NotificationToggles;
}

export function draftFrom(settings: GlobalSettings): SettingsDraft {
  return { ceilings: { ...settings.ceilings }, notifications: { ...settings.notifications } };
}

function sameCeiling(a: Ceiling, b: Ceiling): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The patch that turns `settings` into `draft`, or `null` when nothing changed. */
export function settingsPatch(
  settings: GlobalSettings,
  draft: SettingsDraft,
): GlobalSettingsPatch | null {
  const patch: GlobalSettingsPatch = {};
  const ceilings: NonNullable<GlobalSettingsPatch["ceilings"]> = {};
  for (const v of ["claude", "codex", "copilot"] as const) {
    if (!sameCeiling(settings.ceilings[v], draft.ceilings[v])) ceilings[v] = draft.ceilings[v];
  }
  if (Object.keys(ceilings).length > 0) patch.ceilings = ceilings;
  const notifications: Partial<NotificationToggles> = {};
  for (const k of Object.keys(draft.notifications) as Array<keyof NotificationToggles>) {
    if (settings.notifications[k] !== draft.notifications[k])
      notifications[k] = draft.notifications[k];
  }
  if (Object.keys(notifications).length > 0) patch.notifications = notifications;
  if (Object.keys(patch).length === 0) return null;
  return GlobalSettingsPatchSchema.parse(patch);
}

/** A ceiling of the other kind, with that kind's default values. */
export function switchCeilingKind(c: Ceiling, kind: Ceiling["kind"]): Ceiling {
  if (c.kind === kind) return c;
  return kind === "spend"
    ? { kind: "spend", period: "month", maxUsd: 70 }
    : { kind: "utilization", window: "5h", max: 0.6 };
}
