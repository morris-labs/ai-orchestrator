// The Secrets section of the box dialog: a checklist of the 1Password fields
// the server lists, with an editable variable name for each. The ticks edit
// the project's references, so they apply to every box in the project.
import type { SecretCandidate, SecretRef } from "@agentbox/contracts";
import { Button, errorMessage, useApiClient } from "@agentbox/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  groupCandidates,
  missingRefs,
  rename,
  tick,
  untick,
  type SecretSelection,
} from "../logic/secrets";

export interface SecretsPickerProps {
  /** The ticked references of the project. */
  selection: SecretSelection;
  onChange: (next: SecretSelection) => void;
  /** The global references: always on, and not editable here. */
  globalRefs: readonly SecretRef[];
  /** The project's name, or `null` before the project exists. */
  projectName: string | null;
}

export function SecretsPicker(props: SecretsPickerProps) {
  const { selection, onChange, globalRefs, projectName } = props;
  const client = useApiClient();
  const [candidates, setCandidates] = useState<SecretCandidate[] | null>(null);
  const [vaultNote, setVaultNote] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const r = await client.call("secrets.available", {
          query: { refresh: refresh ? "true" : "false" },
        });
        setCandidates(r.candidates);
        setVaultNote(
          `Vault${r.vaults.length === 1 ? "" : "s"}: ${r.vaults.join(", ")}.` +
            r.vaultErrors.map((e) => ` ${e.vault} could not be read: ${e.message}`).join(""),
        );
      } catch (err) {
        setCandidates(null);
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const globalByRef = useMemo(() => new Map(globalRefs.map((r) => [r.ref, r.name])), [globalRefs]);
  const groups = useMemo(() => groupCandidates(candidates ?? [], filter), [candidates, filter]);
  const missing = useMemo(
    () => (candidates === null ? [] : missingRefs(selection, candidates)),
    [selection, candidates],
  );
  // With no list to compare against, a ticked reference isn't called missing.
  const ticked = Object.keys(selection).length;

  return (
    <div className="bx-secrets">
      <div className="ab-hint">
        These secrets apply to every box in {projectName ? `"${projectName}"` : "this project"}, not
        only this one: the project&apos;s boxes share one container and one secrets broker. A
        process in the box asks for a value by its name, with <code>agentbox-secret</code>.
      </div>
      {globalRefs.length > 0 && (
        <div className="ab-group">
          <div className="bx-dim">From the global settings (always on, edit them there)</div>
          {globalRefs.map((r) => (
            <label key={r.name} className="ab-checkbox ab-disabled">
              <input type="checkbox" checked disabled readOnly aria-label={`Global ${r.name}`} />
              {r.name} <span className="bx-dim">{r.ref}</span>
            </label>
          ))}
        </div>
      )}
      <div className="bx-row">
        <input
          className="ab-input bx-grow"
          aria-label="Filter secrets"
          placeholder="Filter by item, field, or name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button aria-label="Refresh secrets" disabled={loading} onClick={() => void load(true)}>
          Refresh
        </Button>
      </div>
      {loading && <div className="ab-hint">Reading 1Password...</div>}
      {error !== null && (
        <div role="alert" className="ab-error-text">
          {error}
        </div>
      )}
      {candidates !== null && !loading && vaultNote && <div className="ab-hint">{vaultNote}</div>}
      {groups.map((g) => (
        <div key={g.key} className="ab-group" role="group" aria-label={g.item}>
          <div>
            <strong>{g.item}</strong> <span className="bx-dim">{g.vault}</span>
          </div>
          {g.rows.map((c) => {
            const global = globalByRef.get(c.ref);
            const on = global !== undefined || c.ref in selection;
            const label = c.section ? `${c.section} / ${c.field}` : c.field;
            return (
              <div key={c.ref} className="bx-row">
                <label
                  className={`ab-checkbox bx-grow${global !== undefined ? " ab-disabled" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={global !== undefined}
                    aria-label={`${g.item} ${label}`}
                    onChange={(e) =>
                      onChange(e.target.checked ? tick(selection, c) : untick(selection, c.ref))
                    }
                  />
                  {label} <span className="bx-dim">{c.type.toLowerCase()}</span>
                </label>
                <input
                  className="ab-input"
                  aria-label={`Name for ${g.item} ${label}`}
                  value={global ?? selection[c.ref] ?? c.suggestedName}
                  disabled={!(c.ref in selection)}
                  onChange={(e) => onChange(rename(selection, c.ref, e.target.value))}
                />
              </div>
            );
          })}
        </div>
      ))}
      {candidates !== null && groups.length === 0 && !loading && (
        <div className="ab-hint">
          {candidates.length === 0
            ? "No fields with a value were found in these vaults."
            : "No field matches the filter."}
        </div>
      )}
      {missing.length > 0 && (
        <div className="ab-group">
          <div className="bx-dim">Missing from 1Password (untick to remove)</div>
          {missing.map((m) => (
            <label key={m.ref} className="ab-checkbox">
              <input
                type="checkbox"
                checked
                aria-label={`Missing ${m.name}`}
                onChange={() => onChange(untick(selection, m.ref))}
              />
              {m.name} <span className="bx-dim">{m.ref} (missing)</span>
            </label>
          ))}
        </div>
      )}
      <div className="ab-hint">
        {ticked} project secret{ticked === 1 ? "" : "s"} ticked. Changes apply to the running
        container at once, without a restart.
      </div>
    </div>
  );
}
