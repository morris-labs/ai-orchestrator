// Settings: usage ceilings, notification toggles, and vendor defaults,
// saved through the settings PATCH route.
import {
  DEFAULT_COPILOT_MODEL,
  EffortSchema,
  type Ceiling,
  type Effort,
  type GlobalSettings,
  type NotificationToggles,
  type Vendor,
} from "@agentbox/contracts";
import { VENDOR_LABELS, VENDORS } from "@agentbox/ui/dashboard";
import { useEffect, useRef, useState } from "react";
import { ErrorBanner, Field } from "../components/common.js";
import { useApiClient, useAnyEvent } from "@agentbox/ui/hooks";
import {
  draftFrom,
  rebaseDraft,
  settingsPatch,
  switchCeilingKind,
  type SettingsDraft,
  type VendorDefaultsDraft,
} from "./settingsModel.js";

const TOGGLES: Array<{ key: keyof NotificationToggles; label: string }> = [
  { key: "decisionNeeded", label: "A run needs your decision" },
  { key: "runFinished", label: "A run finished" },
  { key: "readyToPush", label: "A run passed review and the branch is ready to push" },
  { key: "roundSummary", label: "A round finished (round summary)" },
  { key: "boxEnded", label: "A box session ended unexpectedly" },
];

function CeilingEditor({
  vendor,
  ceiling,
  onChange,
}: {
  vendor: Vendor;
  ceiling: Ceiling;
  onChange: (c: Ceiling) => void;
}) {
  return (
    <fieldset className="ceiling">
      <legend>{VENDOR_LABELS[vendor]}</legend>
      <Field label="Measure">
        <select
          value={ceiling.kind}
          onChange={(e) => onChange(switchCeilingKind(ceiling, e.target.value as Ceiling["kind"]))}
        >
          <option value="utilization">Share of a rate-limit window</option>
          <option value="spend">Monthly spend</option>
        </select>
      </Field>
      {ceiling.kind === "utilization" ? (
        <>
          <Field label="Window">
            <select
              value={ceiling.window}
              onChange={(e) => onChange({ ...ceiling, window: e.target.value as "5h" | "7d" })}
            >
              <option value="5h">5 hours</option>
              <option value="7d">7 days</option>
            </select>
          </Field>
          <Field label="Ceiling (%)">
            <input
              type="number"
              min={0}
              max={100}
              value={Math.round(ceiling.max * 100)}
              onChange={(e) =>
                onChange({
                  ...ceiling,
                  max: Math.min(1, Math.max(0, Number(e.target.value) / 100)),
                })
              }
            />
          </Field>
        </>
      ) : (
        <Field label="Ceiling (US dollars per month)">
          <input
            type="number"
            min={0}
            value={ceiling.maxUsd}
            onChange={(e) => onChange({ ...ceiling, maxUsd: Math.max(0, Number(e.target.value)) })}
          />
        </Field>
      )}
    </fieldset>
  );
}

function VendorDefaultsEditor({
  value,
  onChange,
}: {
  value: VendorDefaultsDraft;
  onChange: (v: VendorDefaultsDraft) => void;
}) {
  return (
    <div className="ceilings">
      <fieldset className="ceiling">
        <legend>Claude defaults</legend>
        <Field label="Model" hint="Empty: the model from the box's settings files.">
          <input
            value={value.claudeModel}
            placeholder="From the settings files"
            onChange={(e) => onChange({ ...value, claudeModel: e.target.value })}
          />
        </Field>
        <Field label="Effort">
          <select
            value={value.claudeEffort}
            onChange={(e) => onChange({ ...value, claudeEffort: e.target.value as Effort | "" })}
          >
            <option value="">From the settings files</option>
            {EffortSchema.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
      <fieldset className="ceiling">
        <legend>Codex defaults</legend>
        <Field label="Model" hint="Empty: the Codex CLI's default model.">
          <input
            value={value.codexModel}
            placeholder="The Codex CLI's default"
            onChange={(e) => onChange({ ...value, codexModel: e.target.value })}
          />
        </Field>
      </fieldset>
      <fieldset className="ceiling">
        <legend>Copilot defaults</legend>
        <Field
          label="Model"
          hint={`Copilot always gets a model; ${DEFAULT_COPILOT_MODEL} is automatic model selection.`}
        >
          <input
            value={value.copilotModel}
            placeholder={DEFAULT_COPILOT_MODEL}
            onChange={(e) => onChange({ ...value, copilotModel: e.target.value })}
          />
        </Field>
      </fieldset>
    </div>
  );
}

export function Settings() {
  const api = useApiClient();
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  // The settings the draft was last based on, kept outside state so that two
  // events in one batch each rebase onto the one before.
  const baseRef = useRef<GlobalSettings | null>(null);

  useEffect(() => {
    api.call("settings.get").then((s) => {
      // An event that arrived first is newer than this response.
      if (baseRef.current) return;
      baseRef.current = s;
      setSettings(s);
      setDraft(draftFrom(s));
    }, setError);
  }, [api]);

  useAnyEvent((e) => {
    if (e.type === "settings.changed") {
      // Keep unsaved edits; take the change for every field the user left alone.
      const base = baseRef.current;
      baseRef.current = e.settings;
      setDraft((d) => (d && base ? rebaseDraft(base, d, e.settings) : draftFrom(e.settings)));
      setSettings(e.settings);
    }
  });

  if (!settings || !draft) {
    return (
      <div className="screen">
        <h2>Settings</h2>
        <ErrorBanner error={error} />
        {!error ? <p className="muted">Loading…</p> : null}
      </div>
    );
  }
  const patch = settingsPatch(settings, draft);

  async function save() {
    if (!patch) return;
    try {
      const next = await api.call("settings.patch", { body: patch });
      baseRef.current = next;
      setSettings(next);
      setDraft(draftFrom(next));
      setSaved(true);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="screen">
      <h2>Settings</h2>
      <ErrorBanner error={error} />
      {saved && !patch ? (
        <p role="status" className="banner banner-good">
          ✓ Saved.
        </p>
      ) : null}
      <section className="card">
        <h3>Usage ceilings</h3>
        <p className="muted small">
          When a vendor passes its ceiling, the scheduler moves its review and disprove roles to
          another vendor. The fixer stays with Claude, and a run pauses when Claude passes its
          ceiling.
        </p>
        <div className="ceilings">
          {VENDORS.map((v) => (
            <CeilingEditor
              key={v}
              vendor={v}
              ceiling={draft.ceilings[v]}
              onChange={(c) => {
                setSaved(false);
                setDraft({ ...draft, ceilings: { ...draft.ceilings, [v]: c } });
              }}
            />
          ))}
        </div>
      </section>
      <section className="card">
        <h3>Desktop notifications</h3>
        {TOGGLES.map((t) => (
          <label key={t.key} className="check">
            <input
              type="checkbox"
              checked={draft.notifications[t.key]}
              onChange={(e) => {
                setSaved(false);
                setDraft({
                  ...draft,
                  notifications: { ...draft.notifications, [t.key]: e.target.checked },
                });
              }}
            />{" "}
            {t.label}
          </label>
        ))}
      </section>
      <section className="card">
        <h3>Vendor defaults</h3>
        <p className="muted small">
          The model, and for Claude the effort, that review agents use when a run doesn't name one.
          Leave a field empty to use the vendor CLI's own settings.
        </p>
        <VendorDefaultsEditor
          value={draft.vendorDefaults}
          onChange={(vendorDefaults) => {
            setSaved(false);
            setDraft({ ...draft, vendorDefaults });
          }}
        />
      </section>
      <div className="actions">
        <button type="button" className="primary" disabled={!patch} onClick={() => void save()}>
          Save
        </button>
        <button type="button" disabled={!patch} onClick={() => setDraft(draftFrom(settings))}>
          Discard changes
        </button>
      </div>
    </div>
  );
}
