// Run launcher: container, repository, base, tip, pipeline, profile, options,
// a group preview, and Start. A deep link `?project=&box=` prefills it.
import type { ProjectSummary, RouteOf } from "@agentbox/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorBanner, Field } from "../components/common.js";
import { listRefs, listRepos, EMPTY_REFS, type RepoInfo, type RepoRefs } from "../lib/repos.js";
import { href, navigate } from "../state/router.js";
import { useApiClient } from "@agentbox/ui/hooks";
import { DEFAULT_FORM, buildRunRequest, formFromBox, type LauncherForm } from "./launcherModel.js";

type Preview = RouteOf<"runs.preview">["response"];

export function Launcher({ prefill }: { prefill: { project: string | null; box: string | null } }) {
  const api = useApiClient();
  const [form, setForm] = useState<LauncherForm>({
    ...DEFAULT_FORM,
    projectId: prefill.project ?? "",
  });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [reposFromServer, setReposFromServer] = useState(true);
  const [refs, setRefs] = useState<RepoRefs>(EMPTY_REFS);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<"preview" | "start" | null>(null);
  // Set before React renders the disabled form, so a second Enter in the same
  // tick can't start a second request.
  const inFlight = useRef(false);
  const [customBase, setCustomBase] = useState(false);

  const update = (patch: Partial<LauncherForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setPreview(null);
  };

  useEffect(() => {
    api.call("projects.list").then((r) => setProjects(r.projects), setError);
  }, [api]);

  // A later deep link, such as a second-instance launch, changes the prefill
  // while the launcher stays open. A project-only link selects that project
  // as the project menu would; a box link then fills in the rest below.
  useEffect(() => {
    if (!prefill.project) return;
    const projectId = prefill.project;
    setForm((f) => (f.projectId === projectId ? f : { ...f, projectId, repoPath: "", boxId: "" }));
    setPreview(null);
  }, [prefill.project]);

  useEffect(() => {
    if (!prefill.box) return;
    api
      .call("boxes.get", { params: { boxId: prefill.box } })
      .then((view) => setForm((f) => formFromBox(f, view.box)), setError);
  }, [api, prefill.box]);

  const summary = projects.find((p) => p.project.id === form.projectId) ?? null;

  useEffect(() => {
    if (!summary) {
      setRepos([]);
      return;
    }
    let live = true;
    listRepos(api, summary).then((r) => {
      if (!live) return;
      setRepos(r.repos);
      setReposFromServer(r.fromServer);
      setForm((f) => {
        if (f.repoPath) return f;
        const first = r.repos[0];
        return first ? { ...f, repoPath: first.path, tip: f.tip || first.currentBranch || "" } : f;
      });
    }, setError);
    return () => {
      live = false;
    };
  }, [api, summary]);

  useEffect(() => {
    if (!form.projectId || !form.repoPath) return;
    let live = true;
    listRefs(api, form.projectId, form.repoPath).then((r) => live && setRefs(r.refs), setError);
    return () => {
      live = false;
    };
  }, [api, form.projectId, form.repoPath]);

  const repoOptions = useMemo(() => {
    const list = [...repos];
    if (form.repoPath && !list.some((r) => r.path === form.repoPath)) {
      list.unshift({
        path: form.repoPath,
        name: `${form.repoPath} (box worktree)`,
        currentBranch: null,
        headSha: null,
        dirty: false,
      });
    }
    return list;
  }, [repos, form.repoPath]);
  const repo = repoOptions.find((r) => r.path === form.repoPath) ?? null;

  const knownBases = useMemo(
    () =>
      new Set([
        "pr",
        ...refs.remoteBranches,
        ...refs.localBranches,
        ...refs.tags,
        ...refs.recentCommits.map((c) => c.sha),
      ]),
    [refs],
  );
  const baseIsCustom = customBase || (!knownBases.has(form.base) && form.base !== "origin/main");

  async function doPreview() {
    if (inFlight.current) return;
    const built = buildRunRequest(form);
    setErrors(built.ok ? [] : built.errors);
    if (!built.ok) return;
    inFlight.current = true;
    setBusy("preview");
    setError(null);
    try {
      setPreview(await api.call("runs.preview", { body: built.request }));
    } catch (err) {
      setError(err);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function doStart() {
    if (inFlight.current) return;
    const built = buildRunRequest(form);
    setErrors(built.ok ? [] : built.errors);
    if (!built.ok) return;
    inFlight.current = true;
    setBusy("start");
    setError(null);
    try {
      const run = await api.call("runs.create", { body: built.request });
      navigate(href(`/runs/${run.id}`));
    } catch (err) {
      setError(err);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <div className="screen">
      <h2>Start a review run</h2>
      <ErrorBanner error={error} />
      {errors.length > 0 ? (
        <ul role="alert" className="banner banner-error">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      <form
        className="form-grid"
        aria-busy={busy !== null || undefined}
        onSubmit={(e) => {
          e.preventDefault();
          void doStart();
        }}
      >
        <fieldset className="form-contents" disabled={busy !== null}>
          <fieldset>
            <legend>Where</legend>
            <Field label="Container">
              <select
                value={form.projectId}
                onChange={(e) => update({ projectId: e.target.value, repoPath: "", boxId: "" })}
              >
                <option value="">Select a project container</option>
                {projects.map((p) => (
                  <option key={p.project.id} value={p.project.id}>
                    {p.project.name} ({p.container?.name ?? "no container"}
                    {p.container?.engine?.versionMatches === false ? ", engine mismatch" : ""})
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Repository"
              hint={
                reposFromServer
                  ? undefined
                  : "The server can't list repositories yet; showing the project's primary repository."
              }
            >
              <select value={form.repoPath} onChange={(e) => update({ repoPath: e.target.value })}>
                <option value="">Select a repository</option>
                {repoOptions.map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.name}
                    {r.dirty ? " (uncommitted changes)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            {form.boxId ? <p className="muted small">For box {form.boxId}</p> : null}
          </fieldset>

          <fieldset>
            <legend>Range</legend>
            <Field label="Base">
              <select
                value={baseIsCustom ? "__custom" : form.base}
                onChange={(e) => {
                  if (e.target.value === "__custom") {
                    setCustomBase(true);
                  } else {
                    setCustomBase(false);
                    update({ base: e.target.value });
                  }
                }}
              >
                <option value="origin/main">origin/main</option>
                <option value="pr">Base of the open pull request</option>
                {refs.remoteBranches.length > 0 ? (
                  <optgroup label="Remote branches">
                    {refs.remoteBranches
                      .filter((b) => b !== "origin/main")
                      .map((b) => (
                        <option key={`r-${b}`} value={b}>
                          {b}
                        </option>
                      ))}
                  </optgroup>
                ) : null}
                {refs.localBranches.length > 0 ? (
                  <optgroup label="Local branches">
                    {refs.localBranches.map((b) => (
                      <option key={`l-${b}`} value={b}>
                        {b}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {refs.tags.length > 0 ? (
                  <optgroup label="Tags">
                    {refs.tags.map((t) => (
                      <option key={`t-${t}`} value={t}>
                        {t}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {refs.recentCommits.length > 0 ? (
                  <optgroup label="Recent commits">
                    {refs.recentCommits.map((c) => (
                      <option key={`c-${c.sha}`} value={c.sha}>
                        {c.sha.slice(0, 8)} {c.subject}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {refs.pullRequests.length > 0 ? (
                  <optgroup label="Open pull request bases">
                    {refs.pullRequests.map((p) => (
                      <option key={`p-${p.number}`} value={p.baseRef}>
                        #{p.number} base: {p.baseRef}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <option value="__custom">Another ref…</option>
              </select>
            </Field>
            {baseIsCustom ? (
              <Field label="Base ref">
                <input
                  value={form.base}
                  onChange={(e) => update({ base: e.target.value })}
                  placeholder="feature/shared-modules"
                />
              </Field>
            ) : null}
            <div role="radiogroup" aria-label="Diff start" className="radio-row">
              <label>
                <input
                  type="radio"
                  name="baseMode"
                  checked={form.baseMode === "merge-base"}
                  onChange={() => update({ baseMode: "merge-base" })}
                />{" "}
                Merge base (default)
              </label>
              <label>
                <input
                  type="radio"
                  name="baseMode"
                  checked={form.baseMode === "exact"}
                  onChange={() => update({ baseMode: "exact" })}
                />{" "}
                Exact base
              </label>
            </div>
            <Field
              label="Tip branch"
              hint={form.readOnly ? "With read-only, the tip can be a commit." : undefined}
            >
              <input
                list="tip-branches"
                value={form.tip}
                onChange={(e) => update({ tip: e.target.value })}
                placeholder={repo?.currentBranch ?? "Checked-out branch"}
              />
              <datalist id="tip-branches">
                {refs.localBranches.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </Field>
          </fieldset>

          <fieldset>
            <legend>Pipeline</legend>
            <div role="radiogroup" aria-label="Pipeline" className="radio-row">
              <label>
                <input
                  type="radio"
                  name="pipeline"
                  checked={form.pipeline === "pre-push"}
                  onChange={() => update({ pipeline: "pre-push" })}
                />{" "}
                Pre-push
              </label>
              <label>
                <input
                  type="radio"
                  name="pipeline"
                  checked={form.pipeline === "post-push"}
                  onChange={() => update({ pipeline: "post-push" })}
                />{" "}
                Post-push
              </label>
            </div>
            {form.pipeline === "post-push" ? (
              <Field label="Pull request number">
                <input
                  list="open-prs"
                  inputMode="numeric"
                  value={form.prNumber}
                  onChange={(e) => update({ prNumber: e.target.value })}
                />
                <datalist id="open-prs">
                  {refs.pullRequests.map((p) => (
                    <option key={p.number} value={String(p.number)}>
                      {p.title}
                    </option>
                  ))}
                </datalist>
              </Field>
            ) : null}
            <Field label="Profile">
              <select
                value={form.profile}
                onChange={(e) => update({ profile: e.target.value as LauncherForm["profile"] })}
              >
                <option value="offload">offload: Claude fixes only</option>
                <option value="balanced">balanced: Claude reviews rounds 1 and 2</option>
                <option value="fast">fast: Claude reviews every round</option>
              </select>
            </Field>
          </fieldset>

          <fieldset>
            <legend>Options</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={form.readOnly}
                onChange={(e) => update({ readOnly: e.target.checked })}
              />{" "}
              Read-only (review without fixing)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.includeWorktree}
                onChange={(e) => update({ includeWorktree: e.target.checked })}
              />{" "}
              Include uncommitted changes
            </label>
            <Field label="Round cap">
              <input
                type="number"
                min={1}
                value={form.roundCap}
                onChange={(e) => update({ roundCap: e.target.value })}
              />
            </Field>
          </fieldset>

          <div className="actions">
            <button type="button" onClick={() => void doPreview()} disabled={busy !== null}>
              {busy === "preview" ? "Resolving…" : "Preview groups"}
            </button>
            <button type="submit" className="primary" disabled={busy !== null}>
              {busy === "start" ? "Starting…" : "Start"}
            </button>
          </div>
        </fieldset>
      </form>

      {preview ? (
        <section className="card" aria-label="Group preview">
          <h3>Preview</h3>
          <p>
            {preview.groups.length} groups, {preview.changedLines} changed lines, from{" "}
            <code>{preview.diffBaseSha.slice(0, 8)}</code> to{" "}
            <code>{preview.tipSha.slice(0, 8)}</code>.
          </p>
          {preview.dirty && !form.includeWorktree ? (
            <p role="alert" className="banner banner-warning">
              ▲ The working tree has uncommitted changes. Commit them, or select Include uncommitted
              changes.
            </p>
          ) : null}
          <table className="ab-table">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Kind</th>
                <th scope="col">Changed lines</th>
                <th scope="col">Files</th>
              </tr>
            </thead>
            <tbody>
              {preview.groups.map((g) => (
                <tr key={g.id}>
                  <td>{g.id}</td>
                  <td>
                    {g.kind}
                    {g.riskPath ? " (risk path)" : ""}
                  </td>
                  <td className="ab-num">{g.changedLines}</td>
                  <td className="ab-mono">{g.files.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
