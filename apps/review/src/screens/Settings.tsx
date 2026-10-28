// Settings: usage ceilings, notification toggles, and vendor defaults,
// saved through the settings PATCH route.
import type { Ceiling, GlobalSettings, NotificationToggles, Vendor } from "@agentbox/contracts";
import { VENDOR_LABELS, VENDORS } from "@agentbox/ui/dashboard";
import { useEffect, useState } from "react";
import { ErrorBanner, Field } from "../components/common.js";
import { useAppStore, useEvents } from "../state/store.js";
import {
  draftFrom,
  settingsPatch,
  switchCeilingKind,
  type SettingsDraft,
} from "./settingsModel.js";

const TOGGLES: Array<{ key: keyof NotificationToggles; label: string }> = [
  { key: "decisionNeeded", label: "A run needs your decision" },
  { key: "runFinished", label: "A run finished or the branch is ready to push" },
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

export function Settings() {
  const { api } = useAppStore();
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.call("settings.get").then((s) => {
      setSettings(s);
      setDraft(draftFrom(s));
    }, setError);
  }, [api]);

  useEvents((e) => {
    if (e.type === "settings.changed") {
      setSettings(e.settings);
      setDraft(draftFrom(e.settings));
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
        <dl className="facts">
          <dt>Claude</dt>
          <dd>Model from the box's settings files</dd>
          <dt>Codex</dt>
          <dd>The Codex CLI's default model</dd>
          <dt>Copilot</dt>
          <dd>Automatic model selection</dd>
        </dl>
        <p className="muted small">
          The settings route doesn't store vendor defaults yet, so these are the engine's built-in
          choices and can't be changed here.
        </p>
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
