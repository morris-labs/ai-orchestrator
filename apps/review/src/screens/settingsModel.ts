// Builds the settings PATCH body from the edited values: only what changed.
import {
  DEFAULT_COPILOT_MODEL,
  GlobalSettingsPatchSchema,
  type Ceiling,
  type Effort,
  type GlobalSettings,
  type GlobalSettingsPatch,
  type NotificationToggles,
  type Vendor,
} from "@agentbox/contracts";

/** The vendor defaults as form fields: an empty string leaves the choice to the vendor CLI. */
export interface VendorDefaultsDraft {
  claudeModel: string;
  claudeEffort: Effort | "";
  codexModel: string;
  copilotModel: string;
}

export interface SettingsDraft {
  ceilings: Record<Vendor, Ceiling>;
  notifications: NotificationToggles;
  vendorDefaults: VendorDefaultsDraft;
}

export function draftFrom(settings: GlobalSettings): SettingsDraft {
  const d = settings.vendorDefaults;
  return {
    ceilings: { ...settings.ceilings },
    notifications: { ...settings.notifications },
    vendorDefaults: {
      claudeModel: d.claude.model ?? "",
      claudeEffort: d.claude.effort ?? "",
      codexModel: d.codex.model ?? "",
      copilotModel: d.copilot.model,
    },
  };
}

/** The `vendorDefaults` part of the patch: changed fields only, `null` to clear. */
export function vendorDefaultsPatch(
  settings: GlobalSettings,
  draft: VendorDefaultsDraft,
): GlobalSettingsPatch["vendorDefaults"] | undefined {
  const d = settings.vendorDefaults;
  const out: NonNullable<GlobalSettingsPatch["vendorDefaults"]> = {};
  const claudeModel = draft.claudeModel.trim();
  const claude: NonNullable<typeof out.claude> = {};
  if (claudeModel !== (d.claude.model ?? "")) claude.model = claudeModel || null;
  if (draft.claudeEffort !== (d.claude.effort ?? "")) claude.effort = draft.claudeEffort || null;
  if (Object.keys(claude).length > 0) out.claude = claude;
  const codexModel = draft.codexModel.trim();
  if (codexModel !== (d.codex.model ?? "")) out.codex = { model: codexModel || null };
  const copilotModel = draft.copilotModel.trim() || DEFAULT_COPILOT_MODEL;
  if (copilotModel !== d.copilot.model) out.copilot = { model: copilotModel };
  return Object.keys(out).length > 0 ? out : undefined;
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
  const vendorDefaults = vendorDefaultsPatch(settings, draft.vendorDefaults);
  if (vendorDefaults) patch.vendorDefaults = vendorDefaults;
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
