// Run launcher: container, repository, base, tip, pipeline, profile and
// roles, options, a group preview, and Start. A deep link `?project=&box=` prefills it.
import {
  DEPTH_DEFAULTS,
  EffortSchema,
  describeWindowShare,
  type ModelTierChoice,
  type ProjectSummary,
  type RouteOf,
  type Effort,
  MAX_CONCURRENCY,
  RUN_CONCURRENCY_CAPABILITY,
  stageEfforts,
  type RunDepth,
} from "@aio/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorBanner, Field } from "../components/common.js";
import { useFleet, useFleetState } from "../components/machines.js";
import { machineSupports } from "../state/fleet.js";
import { listRefs, listRepos, EMPTY_REFS, type RepoInfo, type RepoRefs } from "../lib/repos.js";
import { href, navigate } from "../state/router.js";
import { useApiClient, useRestoreFocusAfterBusy } from "@aio/ui/hooks";
import { ProfileSelect, RoleTable } from "../components/roles.js";
import {
  DEFAULT_FORM,
  buildRunRequest,
  formFromBox,
  formRoles,
  setFormProfile,
  setFormRole,
  setFormWholeProject,
  type BuildTarget,
  type LauncherForm,
  VERIFY_FLOOR_OPTIONS,
} from "./launcherModel.js";
import { roleConflicts } from "../components/rolesModel.js";

/** What the Parallel calls hint adds for each state of the selected server. */
const CONCURRENCY_HINTS: Record<BuildTarget["concurrency"], string> = {
  yes: "",
  no: " The selected machine's server is too old to use this setting.",
  unknown:
    " The app can't yet confirm that the selected machine's server supports this setting, because the machine list hasn't loaded or the machine is unreachable.",
};

type Preview = RouteOf<"runs.preview">["response"];

export function Launcher({ prefill }: { prefill: { project: string | null; box: string | null } }) {
  const api = useApiClient();
  const fleet = useFleet();
  const fleetState = useFleetState();
  // Without a fleet the launcher has one machine and nothing to check.
  const target: BuildTarget = {
    concurrency:
      fleet === null
        ? "yes"
        : machineSupports(fleetState, fleetState.selected, RUN_CONCURRENCY_CAPABILITY),
  };
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
  const inFlight = useRef<"preview" | "start" | null>(null);
  const [customBase, setCustomBase] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Disabling the fieldset drops focus; it goes back to the same control after.
  useRestoreFocusAfterBusy(formRef, busy !== null);

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
      .then((view) => setForm((f) => formFromBox(f, view.box, view.containerWorkDir)), setError);
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
    const built = buildRunRequest(form, target);
    setErrors(built.ok ? [] : built.errors);
    if (!built.ok) return;
    inFlight.current = "preview";
    setBusy("preview");
    setError(null);
    try {
      setPreview(await api.call("runs.preview", { body: built.request }));
    } catch (err) {
      setError(err);
    } finally {
      inFlight.current = null;
      setBusy(null);
    }
  }

  async function refreshRefs() {
    if (!form.projectId || !form.repoPath) return;
    setRefreshing(true);
    try {
      setRefs((await listRefs(api, form.projectId, form.repoPath, true)).refs);
    } catch (err) {
      setError(err);
    } finally {
      setRefreshing(false);
    }
  }

  async function doStart() {
    if (inFlight.current === "preview") {
      setErrors(["The preview is still resolving. Start the run when it finishes."]);
      return;
    }
    if (inFlight.current) return;
    const built = buildRunRequest(form, target);
    setErrors(built.ok ? [] : built.errors);
    if (!built.ok) return;
    inFlight.current = "start";
    setBusy("start");
    setError(null);
    let run;
    try {
      run = await api.call("runs.create", { body: built.request });
    } catch (err) {
      setError(err);
      inFlight.current = null;
      setBusy(null);
      return;
    }
    // The form stays disabled until the route change unmounts it, so the
    // same run can't start twice.
    navigate(href(`/runs/${run.id}`));
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
        ref={formRef}
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
            <label className="check">
              <input
                type="checkbox"
                checked={form.wholeProject}
                onChange={(e) => {
                  const on = e.target.checked;
                  setForm((f) => setFormWholeProject(f, on));
                  setPreview(null);
                }}
              />{" "}
              Whole project
            </label>
            {form.wholeProject ? (
              <p className="muted small">
                The run reviews the project as it ships at the tip, with no base, and counts every
                finding as introduced. It starts read-only, and you can clear that to allow fixes.
              </p>
            ) : (
              <>
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
              </>
            )}
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
                {form.readOnly
                  ? refs.remoteBranches.map((b) => <option key={`r-${b}`} value={b} />)
                  : null}
              </datalist>
            </Field>
            <button type="button" disabled={refreshing} onClick={() => void refreshRefs()}>
              {refreshing ? "Fetching..." : "Refresh branches"}
            </button>
            {refs.fetchError ? (
              <p role="alert">Couldn't fetch, so the lists can be out of date: {refs.fetchError}</p>
            ) : null}
            {!form.readOnly && refs.remoteBranches.length > 0 ? (
              <p className="hint">Turn on read-only to choose a remote branch as the tip.</p>
            ) : null}
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
                  disabled={form.wholeProject}
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
          </fieldset>

          <fieldset>
            <legend>Profile and roles</legend>
            <Field label="Profile">
              <ProfileSelect
                value={form.profile}
                onChange={(profile) => {
                  setForm((f) => setFormProfile(f, profile));
                  setPreview(null);
                }}
              />
            </Field>
            <p className="muted small">
              The table shows the roles of round 1. A role you change holds until you switch the
              run&apos;s profile; the others follow the profile.
            </p>
            <RoleTable
              name="launcher-role"
              value={formRoles(form)}
              onChange={(role, vendors) => setForm((f) => setFormRole(f, role, vendors))}
              {...(preview?.vendors ? { available: preview.vendors } : {})}
              {...(form.readOnly ? { unused: ["fixer", "confirmer"] as const } : {})}
            />
            <label className="field inline">
              <input
                type="checkbox"
                checked={form.crossVendor}
                onChange={(e) => update({ crossVendor: e.target.checked })}
              />
              <span className="field-label">Cross-vendor checks</span>
            </label>
            <p className="muted small">
              With this on, a vendor never disproves its own findings or confirms its own fixes.
            </p>
            {roleConflicts(formRoles(form), form.crossVendor).map((text) => (
              <p key={text} className="small" role="status">
                {text}
              </p>
            ))}
            <div className="row">
              {/* aria-disabled, not disabled: a disabled button would lose keyboard focus. */}
              <button
                type="button"
                aria-disabled={form.roles === null}
                onClick={() => setForm((f) => ({ ...f, roles: null }))}
              >
                Reset to profile defaults
              </button>
              {form.roles !== null ? (
                <span className="muted small">Changed from the profile&apos;s defaults.</span>
              ) : null}
            </div>
          </fieldset>

          <fieldset>
            <legend>Depth</legend>
            <Field
              label="Depth"
              hint="Standard asks for P1 and P2 findings, with one reviewer pass per group, batched verification, and at most 2 rounds. Thorough asks for every severity, with continuation passes, a disprover call per finding, and at most 25 rounds."
            >
              <select
                value={form.depth}
                onChange={(e) => update({ depth: e.target.value as RunDepth })}
              >
                <option value="standard">Standard</option>
                <option value="thorough">Thorough</option>
              </select>
            </Field>
            <Field
              label="Parallel calls"
              hint={`How many review calls run at once on each vendor, and how many verification calls run at once, from 1 to ${MAX_CONCURRENCY}. More finishes sooner but uses your usage window faster. Default: 6 review calls per vendor and 4 verification calls.${CONCURRENCY_HINTS[target.concurrency]}`}
            >
              <input
                type="number"
                min={1}
                max={MAX_CONCURRENCY}
                value={form.concurrency}
                placeholder="Default"
                onChange={(e) => update({ concurrency: e.target.value })}
              />
            </Field>
            <Field
              label="Reviewer effort"
              hint="Higher effort gives reviewers more time to reason and can cost more. The preview shows the closest supported level for each planned reviewer model."
            >
              <select
                value={form.reviewerEffort}
                onChange={(e) => update({ reviewerEffort: e.target.value as Effort | "" })}
              >
                <option value="">Vendor default</option>
                {EffortSchema.options.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort === "xhigh" ? "Extra high" : effort[0]?.toUpperCase() + effort.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
          </fieldset>

          <fieldset>
            <legend>Verification</legend>
            <Field
              label="Verification floor"
              hint="Findings below this severity stay pending and unchecked. They stay listed, never go to the fixer, and keep the run from reporting clean."
            >
              <select
                value={form.verifyFloor}
                onChange={(e) =>
                  update({ verifyFloor: e.target.value as LauncherForm["verifyFloor"] })
                }
              >
                <option value="default">
                  Depth default ({form.depth === "standard" ? "P2 and above" : "all severities"})
                </option>
                {VERIFY_FLOOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </fieldset>

          <fieldset>
            <legend>Model tier</legend>
            <Field
              label="Tier"
              hint="Auto picks a tier for each group and role. A fixed tier applies to the run, but with Small, code, disprovers, confirmers, and fixers still use Medium."
            >
              <select
                value={form.modelTier}
                onChange={(e) => update({ modelTier: e.target.value as ModelTierChoice })}
              >
                <option value="auto">Auto</option>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
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
            <label className="check">
              <input
                type="checkbox"
                checked={form.rootCauses}
                onChange={(e) => update({ rootCauses: e.target.checked })}
              />{" "}
              Group confirmed findings by root cause (one extra call when the run finishes)
            </label>
            <Field
              label="Exclude paths"
              hint="Globs of files this run never groups or reviews, one per line, added to the policy's excludePaths."
            >
              <textarea
                rows={2}
                value={form.excludePaths}
                onChange={(e) => update({ excludePaths: e.target.value })}
                placeholder="fixtures/**"
              />
            </Field>
            <Field label="Round cap">
              <input
                type="number"
                min={1}
                value={form.roundCap}
                placeholder={`Depth default: ${DEPTH_DEFAULTS[form.depth].roundCap}`}
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
            {preview.groups.length} groups, {preview.changedLines} changed lines,{" "}
            {form.wholeProject ? (
              <>
                the whole project at <code>{preview.tipSha.slice(0, 8)}</code>.
              </>
            ) : (
              <>
                from <code>{preview.diffBaseSha.slice(0, 8)}</code> to{" "}
                <code>{preview.tipSha.slice(0, 8)}</code>.
              </>
            )}
          </p>
          {preview.excluded ? (
            <details aria-label="Excluded files">
              <summary>Excluded files: {preview.excluded.count}</summary>
              {preview.excluded.count > preview.excluded.files.length ? (
                <p className="muted small">
                  Showing the first {preview.excluded.files.length} files.
                </p>
              ) : null}
              <ul className="ab-mono">
                {preview.excluded.files.map((f) => (
                  <li key={f.path}>
                    {f.path} ({f.source})
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {preview.tokenEstimate ? (
            <p aria-label="Token estimate">
              Estimated tokens: about {preview.tokenEstimate.tokens.toLocaleString("en-US")}
              {preview.tokenEstimate.low !== undefined && preview.tokenEstimate.high !== undefined
                ? `, likely ${preview.tokenEstimate.low.toLocaleString("en-US")} to ${preview.tokenEstimate.high.toLocaleString("en-US")}`
                : ""}
              . This is a rough estimate, not a measurement. {preview.tokenEstimate.basis}
            </p>
          ) : null}
          {preview.tokenEstimate?.windows?.length ? (
            <ul aria-label="Usage window estimate">
              {preview.tokenEstimate.windows.map((line) => (
                <li key={`${line.vendor}/${line.window}`} title={line.source}>
                  Usage: {describeWindowShare(line)}.
                </li>
              ))}
            </ul>
          ) : null}
          {preview.tokenEstimate?.lines?.length ? (
            <ul aria-label="Token estimate by stage">
              {preview.tokenEstimate.lines.map((line) => (
                <li key={line.label}>
                  {line.label}: about {line.tokens.toLocaleString("en-US")} (
                  {line.low.toLocaleString("en-US")} to {line.high.toLocaleString("en-US")})
                </li>
              ))}
            </ul>
          ) : null}
          {preview.reviewerEfforts?.length ? (
            <ul aria-label="Effective reviewer effort">
              {preview.reviewerEfforts.map(({ vendor, model, effort, note }) => (
                <li key={JSON.stringify([vendor, model])}>
                  {vendor}
                  {model ? ` (${model})` : ""}: {effort ?? "default"}
                  {note ? `. ${note}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          <ul aria-label="Effort by stage">
            {stageEfforts(form.reviewerEffort || undefined)
              .filter((e) => e.stage !== "Review" || preview.reviewerEfforts === undefined)
              .map((e) => (
                <li key={e.stage}>
                  {e.stage} effort: {e.effort}
                </li>
              ))}
          </ul>
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
                <th scope="col">Tier</th>
                <th scope="col">Reason</th>
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
                  <td>{g.tier ?? "None"}</td>
                  <td>{g.tierReason ?? ""}</td>
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
