// Policy editor: loads and saves `<project>/.aio/policy.yaml` through
// the server, as a form or as raw YAML, validated with the contract schema.
// It saves the file's text, so comments in the file survive, and passes the
// revision it loaded, so a file changed on disk meanwhile isn't overwritten
// without asking.
import type { PolicyCommand, PolicyFile, PolicyRule, ProjectSummary } from "@aio/contracts";
import { DEFAULT_POLICY } from "@aio/contracts";
import { useEffect, useRef, useState } from "react";
import { ErrorBanner, Field } from "../components/common.js";
import { href, navigate, setLeaveGuard } from "../state/router.js";
import { isApiError } from "@aio/ui/core";
import { useApiClient } from "@aio/ui/hooks";
import {
  commaList,
  lines,
  mergePolicyYaml,
  parsePolicyYaml,
  policyToYaml,
  sameList,
  validatePolicy,
} from "./policyModel.js";

function CommandList({
  label,
  items,
  onChange,
}: {
  label: string;
  items: PolicyCommand[];
  onChange: (items: PolicyCommand[]) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {items.map((c, i) => (
        <div key={i} className="row">
          <input
            aria-label={`${label} ${i + 1} command`}
            value={c.command}
            placeholder="npm test"
            onChange={(e) =>
              onChange(items.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))
            }
          />
          <input
            aria-label={`${label} ${i + 1} directory`}
            value={c.cwd ?? ""}
            placeholder="Repository root"
            onChange={(e) =>
              onChange(
                items.map((x, j) => (j === i ? { ...x, cwd: e.target.value || undefined } : x)),
              )
            }
          />
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, { command: "" }])}>
        Add a command
      </button>
    </fieldset>
  );
}

/**
 * A comma-separated glob list. It keeps the text as typed, so a trailing
 * comma or space survives until the next glob is typed, and takes the value
 * again only when it changes from outside, such as on a project load.
 */
function GlobListInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
}) {
  const joined = value?.join(", ") ?? "";
  const [text, setText] = useState(joined);
  useEffect(() => {
    setText((t) => (sameList(commaList(t), value) ? t : joined));
  }, [joined, value]);
  return (
    <input
      aria-label={label}
      value={text}
      placeholder="Every file, or globs separated by commas"
      onChange={(e) => {
        setText(e.target.value);
        onChange(commaList(e.target.value));
      }}
    />
  );
}

function RuleList({
  rules,
  onChange,
}: {
  rules: PolicyRule[];
  onChange: (r: PolicyRule[]) => void;
}) {
  return (
    <fieldset>
      <legend>Rules</legend>
      {rules.map((r, i) => (
        <div key={i} className="rule">
          <div className="row">
            <input
              aria-label={`Rule ${i + 1} id`}
              value={r.id}
              placeholder="no-phi-in-logs"
              onChange={(e) =>
                onChange(rules.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))
              }
            />
            <GlobListInput
              label={`Rule ${i + 1} applies to`}
              value={r.appliesTo}
              onChange={(appliesTo) =>
                onChange(rules.map((x, j) => (j === i ? { ...x, appliesTo } : x)))
              }
            />
            <button type="button" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
          <textarea
            aria-label={`Rule ${i + 1} text`}
            value={r.text}
            rows={2}
            onChange={(e) =>
              onChange(rules.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
            }
          />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rules, { id: "", text: "" }])}>
        Add a rule
      </button>
    </fieldset>
  );
}

/** What a load or a save of the policy returned. */
interface Loaded {
  path: string;
  exists: boolean;
  policy: PolicyFile;
  text?: string | null;
  revision?: string;
}

export function Policy({ projectId }: { projectId: string | null }) {
  const api = useApiClient();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [policy, setPolicy] = useState<PolicyFile>(DEFAULT_POLICY);
  const [meta, setMeta] = useState<{ path: string; exists: boolean } | null>(null);
  const [tab, setTab] = useState<"form" | "yaml">("form");
  // The file's text, comments included. The YAML tab edits it; a save from
  // the form applies the form's changes to it, so comments survive.
  const [yamlText, setYamlText] = useState("");
  const [riskText, setRiskText] = useState("");
  const [limitsText, setLimitsText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  // The revision the form was loaded from; a save fails with `conflict` when
  // the file changed on disk since then.
  const [revision, setRevision] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  // The project whose policy the form holds. Save stays off until the
  // selected project's policy loads, so a failed or late load can't write
  // one project's policy into another.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    api.call("projects.list").then((r) => setProjects(r.projects), setError);
  }, [api]);
  const selected = projectId ?? projects[0]?.project.id ?? null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Unsaved edits are lost on a project switch or a route change: ask first.
  useEffect(() => {
    if (!dirty) return;
    return setLeaveGuard(() => window.confirm("Discard the unsaved changes to the policy?"));
  }, [dirty]);

  /** Marks the form as changed since the last load or save. */
  function edited() {
    setDirty(true);
    setSaved(false);
    setConflict(false);
  }

  function load(r: Loaded) {
    setMeta({ path: r.path, exists: r.exists });
    setPolicy(r.policy);
    setYamlText(r.text ?? policyToYaml(r.policy));
    setRiskText(r.policy.riskPaths.join("\n"));
    setLimitsText(r.policy.environmentLimits.join("\n"));
    setRevision(r.revision);
    setErrors([]);
    setDirty(false);
    setConflict(false);
  }

  useEffect(() => {
    if (!selected) return;
    let live = true;
    setSaved(false);
    setLoadedFor(null);
    setMeta(null);
    setError(null);
    api.call("projects.policy.get", { params: { projectId: selected } }).then(
      (r) => {
        if (!live) return;
        load(r);
        setLoadedFor(selected);
      },
      (err: unknown) => {
        if (live) setError(err);
      },
    );
    return () => {
      live = false;
    };
  }, [api, selected, reloads]);

  /** The policy as the active tab holds it. */
  function current(): ReturnType<typeof validatePolicy> {
    if (tab === "yaml") return parsePolicyYaml(yamlText);
    return validatePolicy({
      ...policy,
      riskPaths: lines(riskText),
      environmentLimits: lines(limitsText),
    });
  }

  function switchTab(next: "form" | "yaml") {
    if (next === tab) return;
    const r = current();
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    // The YAML tab keeps its own text, comments included; the form's
    // changes go into it key by key.
    if (next === "yaml") setYamlText(mergePolicyYaml(yamlText, r.policy));
    setPolicy(r.policy);
    setRiskText(r.policy.riskPaths.join("\n"));
    setLimitsText(r.policy.environmentLimits.join("\n"));
    setErrors([]);
    setTab(next);
  }

  async function save(overwrite = false) {
    const target = loadedFor;
    if (!target || target !== selected) return;
    const r = current();
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    const text = tab === "yaml" ? yamlText : mergePolicyYaml(yamlText, r.policy);
    try {
      const res = await api.call("projects.policy.put", {
        params: { projectId: target },
        ...(revision && !overwrite ? { query: { baseRevision: revision } } : {}),
        body: { text },
      });
      // The user may have switched projects while the save ran.
      if (selectedRef.current !== target) return;
      load(res);
      setSaved(true);
      setError(null);
    } catch (err) {
      if (selectedRef.current !== target) return;
      if (isApiError(err, "conflict")) setConflict(true);
      else setError(err);
    }
  }

  function reload() {
    setDirty(false);
    setConflict(false);
    setReloads((n) => n + 1);
  }

  return (
    <div className="screen">
      <h2>Policy</h2>
      <ErrorBanner error={error} />
      <Field label="Project">
        <select
          value={selected ?? ""}
          onChange={(e) => navigate(href("/policy", { project: e.target.value }))}
        >
          {projects.map((p) => (
            <option key={p.project.id} value={p.project.id}>
              {p.project.name}
            </option>
          ))}
        </select>
      </Field>
      {meta ? (
        <p className="muted small">
          <span className="mono">{meta.path}</span>
          {meta.exists ? "" : " does not exist yet; saving creates it."}
        </p>
      ) : null}
      <div role="tablist" className="tabs">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "form"}
          onClick={() => switchTab("form")}
        >
          Form
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "yaml"}
          onClick={() => switchTab("yaml")}
        >
          YAML
        </button>
      </div>
      {errors.length > 0 ? (
        <ul role="alert" className="banner banner-error">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {conflict ? (
        <div role="alert" className="banner banner-warning">
          The file changed on disk since you opened it. Reload it to see the changes, or overwrite
          it with yours.
          <div className="actions">
            <button type="button" onClick={reload}>
              Reload
            </button>
            <button type="button" className="danger" onClick={() => void save(true)}>
              Overwrite
            </button>
          </div>
        </div>
      ) : null}
      {saved && !dirty ? (
        <p role="status" className="banner banner-good">
          ✓ Saved.
        </p>
      ) : dirty ? (
        <p role="status" className="muted small">
          Unsaved changes.
        </p>
      ) : null}
      {tab === "form" ? (
        <div className="form-grid" role="tabpanel">
          <Field label="Risk paths" hint="One glob per line. Matching files always count as major.">
            <textarea
              rows={4}
              value={riskText}
              onChange={(e) => {
                edited();
                setRiskText(e.target.value);
              }}
            />
          </Field>
          <Field
            label="Environment limits"
            hint="One fact per line, such as Windows-only code paths under win/."
          >
            <textarea
              rows={3}
              value={limitsText}
              onChange={(e) => {
                edited();
                setLimitsText(e.target.value);
              }}
            />
          </Field>
          <Field
            label="Group size limit"
            hint="A group with more changed lines splits into smaller groups."
          >
            <input
              type="number"
              min={1}
              value={policy.groupSizeLimit}
              onChange={(e) => {
                edited();
                setPolicy({ ...policy, groupSizeLimit: Number(e.target.value) });
              }}
            />
          </Field>
          <RuleList
            rules={policy.rules}
            onChange={(rules) => {
              edited();
              setPolicy({ ...policy, rules });
            }}
          />
          <CommandList
            label="Tests"
            items={policy.tests}
            onChange={(tests) => {
              edited();
              setPolicy({ ...policy, tests });
            }}
          />
          <CommandList
            label="Lint"
            items={policy.lint}
            onChange={(lint) => {
              edited();
              setPolicy({ ...policy, lint });
            }}
          />
        </div>
      ) : (
        <div role="tabpanel">
          <textarea
            aria-label="Policy YAML"
            className="code-input"
            rows={24}
            spellCheck={false}
            value={yamlText}
            onChange={(e) => {
              edited();
              setYamlText(e.target.value);
            }}
          />
        </div>
      )}
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={!selected || loadedFor !== selected}
        >
          Save
        </button>
      </div>
    </div>
  );
}
