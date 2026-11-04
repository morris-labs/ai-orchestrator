// The run view: stepper, round counter, roles with manual assignment,
// profile switch, controls, the decision panel, round summaries, the run's
// live agents, and cost per round.
import {
  runDepth,
  type Decision,
  type DecisionOption,
  type FileGroup,
  type Finding,
  type Role,
  type Severity,
  type RoundSummary,
  type RunState,
  type Vendor,
} from "@aio/contracts";
import { AgentsTable, VENDOR_LABELS, VENDORS, agentRows, formatUsd } from "@aio/ui/dashboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBanner, RunStatusBadge, shortId } from "../components/common.js";
import { ProfileSelect, RoleTable } from "../components/roles.js";
import { draftFromRoles, sameVendors, type RoleDraft } from "../components/rolesModel.js";
import { EventBuffer } from "../state/eventBuffer.js";
import { href } from "../state/router.js";
import { useApiClient, useAnyEvent } from "@aio/ui/hooks";
import { useStore } from "../state/store.js";
import { VERIFY_FLOOR_OPTIONS } from "./launcherModel.js";
import { decisionView, isNewerRun, oscillationPairs, runControls, stepStates } from "./runModel.js";

export function StageStepper({ run }: { run: Pick<RunState, "stage" | "status" | "request"> }) {
  const steps = stepStates(run.request.pipeline, run.stage, run.status);
  return (
    <ol className="stepper" aria-label="Stages">
      {steps.map((s) => (
        <li
          key={s.stage}
          className={`step step-${s.state}`}
          data-state={s.state}
          aria-current={s.state !== "done" && s.state !== "todo" ? "step" : undefined}
        >
          <span className="step-icon" aria-hidden="true">
            {
              { done: "✓", current: "◐", todo: "○", paused: "‖", blocked: "▲", failed: "✕" }[
                s.state
              ]
            }
          </span>
          {s.stage}
        </li>
      ))}
    </ol>
  );
}

function FindingCard({ finding, label }: { finding: Finding; label?: string }) {
  return (
    <article className="finding-card">
      {label ? <div className="muted small">{label}</div> : null}
      <h4>
        {finding.id} <span className={`sev sev-${finding.severity}`}>{finding.severity}</span>{" "}
        {finding.title}
      </h4>
      <p className="mono small">
        {finding.file ?? "No location"}
        {finding.lines ? `:${finding.lines[0]}-${finding.lines[1]}` : ""} · round {finding.round} ·{" "}
        {finding.verdict}
      </p>
      <p>{finding.failureCase}</p>
      {finding.evidence ? <pre className="evidence">{finding.evidence}</pre> : null}
    </article>
  );
}

export function DecisionPanel({
  decision,
  findings,
  onDecide,
  busy,
}: {
  decision: Decision;
  findings: readonly Finding[];
  onDecide: (option: DecisionOption, reason: string) => void;
  busy?: boolean;
}) {
  const view = decisionView(decision);
  const [reason, setReason] = useState("");
  return (
    <section className="card decision" aria-label="Decision needed" role="region">
      <h3>▲ {view.title}</h3>
      <p>{view.explanation}</p>
      {decision.message ? <p className="decision-message">{decision.message}</p> : null}
      {view.compareVersions
        ? oscillationPairs(findings).map(({ before, after }) => (
            <div key={before.fingerprint} className="compare">
              <FindingCard finding={before} label="Before: closed by a fix" />
              <FindingCard finding={after} label="Now: raised again" />
            </div>
          ))
        : findings.map((f) => <FindingCard key={f.id} finding={f} />)}
      {view.buttons.some((b) => b.needsReason) ? (
        <label className="field">
          <span className="field-label">Reason for waiving</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Accepted risk: …"
          />
        </label>
      ) : null}
      <div className="actions">
        {view.buttons.map((b) => (
          <button
            key={b.option}
            type="button"
            className={
              b.option === "cancel" ? "danger" : b.option === "resume" ? "primary" : undefined
            }
            disabled={busy || (b.needsReason && reason.trim() === "")}
            onClick={() => onDecide(b.option, reason.trim())}
          >
            {b.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function RoundTable({ rounds }: { rounds: readonly RoundSummary[] }) {
  if (rounds.length === 0) return <p className="muted">No round has finished.</p>;
  const total = rounds.reduce((s, r) => s + r.costUsd, 0);
  return (
    <div className="ab-table-wrap">
      <table className="ab-table">
        <thead>
          <tr>
            <th scope="col">Round</th>
            {VENDORS.map((v) => (
              <th key={v} scope="col">
                {VENDOR_LABELS[v]} raised / confirmed / disproved
              </th>
            ))}
            <th scope="col">Fixed</th>
            <th scope="col">Overlap</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((r) => (
            <tr key={r.round}>
              <td className="ab-num">{r.round}</td>
              {VENDORS.map((v) => {
                const s = r.perVendor[v];
                return (
                  <td key={v} className="ab-num">
                    {s ? `${s.raised} / ${s.confirmed} / ${s.disproved}` : "–"}
                  </td>
                );
              })}
              <td className="ab-num">{r.fixed}</td>
              <td className="ab-num">{Math.round(r.overlapRate * 100)}%</td>
              <td className="ab-num">{formatUsd(r.costUsd)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={VENDORS.length + 3}>
              Total
            </th>
            <td className="ab-num">{formatUsd(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function RoleEditor({
  run,
  disabled,
  onAssign,
}: {
  run: RunState;
  disabled: boolean;
  onAssign: (role: Role, vendors: Vendor[]) => void;
}) {
  // Reset the draft only when the run's roles actually change. Resetting from
  // an effect raced a click made before the mount effect flushed: the effect's
  // update landed after the click's and wiped the choice.
  const rolesKey = JSON.stringify(run.roles);
  const [draft, setDraft] = useState<RoleDraft>(() => draftFromRoles(run.roles));
  const [draftKey, setDraftKey] = useState(rolesKey);
  if (draftKey !== rolesKey) {
    setDraftKey(rolesKey);
    setDraft(draftFromRoles(run.roles));
  }
  const current = draftFromRoles(run.roles);
  return (
    <RoleTable
      value={draft}
      disabled={disabled}
      onChange={(role, vendors) => setDraft((d) => ({ ...d, [role]: vendors }))}
      action={{
        header: "Apply",
        render: (role, chosen) => (
          <button
            type="button"
            disabled={disabled || sameVendors(chosen, current[role]) || chosen.length === 0}
            onClick={() => onAssign(role, chosen)}
          >
            Assign
          </button>
        ),
      }}
    />
  );
}

/** Retries a failed run. The role table on this page changes vendors first. */
function RetryControl({
  run,
  busy,
  onRetry,
}: {
  run: RunState;
  busy: boolean;
  onRetry: (verifyFloor: Severity | "all", finishWithClaude?: boolean) => void;
}) {
  const [floor, setFloor] = useState<Severity | "all">(run.request.verifyFloor ?? "all");
  return (
    <>
      <label>
        Verification floor{" "}
        <select
          value={floor}
          disabled={busy}
          onChange={(e) => setFloor(e.target.value as Severity | "all")}
        >
          {VERIFY_FLOOR_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="primary" disabled={busy} onClick={() => onRetry(floor)}>
        Retry
      </button>
      <button
        type="button"
        disabled={busy}
        title="Gives the remaining work to Claude and turns off the cross-vendor rule, so Claude checks its own findings."
        onClick={() => onRetry(floor, true)}
      >
        Finish with Claude
      </button>
    </>
  );
}

export function RunView({ runId }: { runId: string }) {
  const api = useApiClient();
  const [run, setRun] = useState<RunState | null>(null);
  const [rounds, setRounds] = useState<RoundSummary[]>([]);
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [decisionFindings, setDecisionFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const resets = useStore((s) => s.resets);
  const dashboard = useStore((s) => s.dashboard);
  const agents = agentRows(dashboard, runId);
  const round = run?.round;

  // The tiers are extra detail: a failed read leaves the run view as it is,
  // and the next round or reconnect reads them again. The first read waits
  // for the run, so one mount makes one request.
  useEffect(() => {
    if (round === undefined) return;
    let live = true;
    api.call("runs.groups", { params: { runId } }).then(
      (r) => live && setGroups(r.groups),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, runId, round, resets]);

  // The newest run state seen from either REST or the event stream. Kept in
  // a ref so a late response can be compared without a state updater.
  const latest = useRef<RunState | null>(null);
  // The run as the last stage.changed left it. A run from REST at the same
  // `updatedAt` but another stage predates that event.
  const stageEvent = useRef<{ updatedAt: string; stage: RunState["stage"] } | null>(null);
  const applyRun = useCallback((next: RunState): boolean => {
    if (!isNewerRun(latest.current, next)) return false;
    const s = stageEvent.current;
    if (s && next.updatedAt === s.updatedAt && next.stage !== s.stage) return false;
    latest.current = next;
    setRun(next);
    return true;
  }, []);

  const load = useCallback(async () => {
    try {
      const [r, rs] = await Promise.all([
        api.call("runs.get", { params: { runId } }),
        api.call("runs.rounds", { params: { runId } }),
      ]);
      // The rounds come from the same moment as the run, so a stale run
      // means stale rounds too.
      if (applyRun(r)) setRounds(rs.rounds);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [api, runId, applyRun]);

  useEffect(() => {
    void load();
  }, [load, resets]);

  useAnyEvent((e) => {
    if (e.type === "run.changed" && e.run.id === runId) {
      if (!applyRun(e.run)) return;
      const summary = e.roundSummary;
      if (summary)
        setRounds((rs) =>
          [...rs.filter((r) => r.round !== summary.round), summary].sort(
            (a, b) => a.round - b.round,
          ),
        );
    } else if (e.type === "stage.changed" && e.runId === runId) {
      const prev = latest.current;
      if (prev) {
        // The event's time is when the run changed, so it counts as the
        // run's `updatedAt`, and a REST run from before it is older.
        const updatedAt = Date.parse(e.time) > Date.parse(prev.updatedAt) ? e.time : prev.updatedAt;
        latest.current = { ...prev, stage: e.stage, round: e.round, updatedAt };
        stageEvent.current = { updatedAt, stage: e.stage };
        setRun(latest.current);
      }
    }
  });

  const decisionKey = run?.decision ? run.decision.findingIds.join(",") : "";
  useEffect(() => {
    if (!run?.decision) {
      setDecisionFindings([]);
      return;
    }
    const ids = run.decision.findingIds;
    let live = true;
    (async () => {
      const found = await Promise.all(
        ids.map((findingId) =>
          api.call("findings.get", { params: { runId, findingId } }).then((d) => d.finding),
        ),
      );
      // For an oscillation, also load earlier findings with the same fingerprint.
      if (run.decision?.kind === "oscillation") {
        const { findings } = await api.call("findings.list", { params: { runId } });
        const prints = new Set(found.map((f) => f.fingerprint));
        for (const f of findings)
          if (prints.has(f.fingerprint) && !found.some((x) => x.id === f.id)) found.push(f);
      }
      if (live) setDecisionFindings(found);
    })().catch(setError);
    return () => {
      live = false;
    };
  }, [api, runId, decisionKey]);

  async function act(fn: () => Promise<RunState>) {
    setBusy(true);
    try {
      applyRun(await fn());
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!run) {
    return (
      <div className="screen">
        <h2>Run {shortId(runId)}</h2>
        <ErrorBanner error={error} />
        {!error ? <p className="muted">Loading…</p> : null}
      </div>
    );
  }

  const controls = runControls(run);
  const params = { runId };
  const liveCost = dashboard.runs[runId]?.liveCostByRound ?? {};
  const currentRoundCost = liveCost[run.round];

  return (
    <div className="screen">
      <header className="run-head">
        <div>
          <h2>
            Run <span className="mono">{shortId(run.id)}</span>{" "}
            <RunStatusBadge status={run.status} />
          </h2>
          <p className="muted small">
            {run.request.pipeline} · {run.request.repoPath} ·{" "}
            {run.request.scope === "whole"
              ? "whole project"
              : `base ${run.request.base}${run.baseSha ? ` (${run.baseSha.slice(0, 8)})` : ""}`}{" "}
            · tip {run.request.tip ?? "checked-out branch"}
            {run.request.excludePaths?.length
              ? ` · excludes ${run.request.excludePaths.join(", ")}`
              : ""}
            {run.request.readOnly ? " · read-only" : ""} · depth {runDepth(run.request)}
          </p>
        </div>
        <div className="round-counter" aria-label="Round">
          <span className="tile-label">Round</span>
          <span className="tile-value">
            {run.round} {/* A run that continued after a push has its own cap past this one. */}
            {run.round > run.request.roundCap ? null : (
              <span className="muted">of {run.request.roundCap}</span>
            )}
          </span>
          {currentRoundCost !== undefined ? (
            <span className="muted small">{formatUsd(currentRoundCost)} so far this round</span>
          ) : null}
        </div>
      </header>
      <ErrorBanner error={error} />
      <StageStepper run={run} />
      {run.stopReason ? (
        <p className="muted">Stopped: {run.stopReason.replace(/_/g, " ")}.</p>
      ) : null}
      {run.error ? <p className="banner banner-error">✕ {run.error}</p> : null}
      {(run.notices ?? []).map((notice, i) => (
        <p key={i} className="banner banner-warning">
          ! {notice}
        </p>
      ))}
      {run.pausedUntil ? (
        <p className="banner banner-warning">
          ‖ Paused until {new Date(run.pausedUntil).toLocaleString()}.
        </p>
      ) : null}

      {run.status === "waiting_decision" && run.decision ? (
        <DecisionPanel
          decision={run.decision}
          findings={decisionFindings}
          busy={busy}
          onDecide={(option, reason) =>
            void act(() =>
              api.call("runs.decide", {
                params,
                body: {
                  option,
                  // An empty list lets the engine waive the decision's
                  // findings that are not fixed. An oscillation lists the
                  // fixed finding too, which must keep its verdict.
                  waiveFindingIds: [],
                  reason: reason || undefined,
                },
              }),
            )
          }
        />
      ) : null}

      <div className="actions">
        {controls.pause ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => api.call("runs.pause", { params }))}
          >
            Pause
          </button>
        ) : null}
        {controls.resume ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void act(() => api.call("runs.resume", { params }))}
          >
            Resume
          </button>
        ) : null}
        {controls.retry ? (
          <RetryControl
            run={run}
            busy={busy}
            onRetry={(verifyFloor, finishWithClaude) =>
              void act(() =>
                api.call("runs.retry", { params, body: { verifyFloor, finishWithClaude } }),
              )
            }
          />
        ) : null}
        {controls.rebaseBase ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => api.call("runs.rebaseBase", { params }))}
          >
            Re-resolve base
          </button>
        ) : null}
        {controls.cancel ? (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void act(() => api.call("runs.cancel", { params }))}
          >
            Cancel run
          </button>
        ) : null}
        {controls.push ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              void act(() => api.call("runs.push", { params, body: { draft: false } }))
            }
          >
            Push and open the pull request
          </button>
        ) : null}
        {run.prUrl ? (
          <a href={run.prUrl} target="_blank" rel="noreferrer">
            Pull request #{run.prNumber}
          </a>
        ) : null}
        <a href={href("/findings", { run: run.id })}>Findings</a>
      </div>

      <section className="card">
        <h3>Profile and roles</h3>
        <label className="field inline">
          <span className="field-label">Profile</span>
          <ProfileSelect
            value={run.profile}
            disabled={!controls.steer || busy}
            onChange={(profile) =>
              void act(() => api.call("runs.profile", { params, body: { profile } }))
            }
          />
        </label>
        <p className="muted small">
          A profile applies from the next round. A role applies to calls that haven&apos;t started.
        </p>
        <RoleEditor
          run={run}
          disabled={!controls.steer || busy}
          onAssign={(role, vendors) =>
            void act(() => api.call("runs.assign", { params, body: { role, vendors } }))
          }
        />
      </section>

      <section className="card">
        <h3>Round summaries</h3>
        <RoundTable rounds={rounds} />
      </section>

      {groups.some((g) => g.tier) ? (
        <section className="card">
          <h3>Model tiers</h3>
          <p className="muted small">
            Each group&apos;s base tier. A call&apos;s role, persisting findings, or a malformed
            answer can move it up; the agents table shows the tier each call used.
          </p>
          <table className="ab-table" aria-label="Model tiers">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Tier</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>{g.id}</td>
                  <td>{g.tier ?? "None"}</td>
                  <td>{g.tierReason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <AgentsTable agents={agents} title="Agents in this run" />
    </div>
  );
}

export function RunList() {
  const api = useApiClient();
  const [runs, setRuns] = useState<RunState[]>([]);
  const [error, setError] = useState<unknown>(null);
  const resets = useStore((s) => s.resets);
  // Runs that change while the list loads keep their newer state.
  const [buffer] = useState(() => new EventBuffer<RunState>());
  useEffect(() => {
    let live = true;
    const during = buffer.start();
    api.call("runs.list").then(
      (r) => {
        if (!live) return;
        setRuns(
          buffer.finish(
            during,
            r.runs,
            (x) => x.id,
            (e, l) => isNewerRun(l, e),
          ),
        );
      },
      (err: unknown) => {
        buffer.cancel(during);
        if (live) setError(err);
      },
    );
    return () => {
      live = false;
      buffer.cancel(during);
    };
  }, [api, resets, buffer]);
  useAnyEvent((e) => {
    if (e.type !== "run.changed") return;
    buffer.record(e.run.id, e.run);
    setRuns((rs) => [e.run, ...rs.filter((r) => r.id !== e.run.id)]);
  });
  const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="screen">
      <h2>Runs</h2>
      <ErrorBanner error={error} />
      {sorted.length === 0 ? (
        <p className="muted">
          No runs yet. <a href={href("/launch")}>Start one.</a>
        </p>
      ) : (
        <table className="ab-table">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Status</th>
              <th scope="col">Stage</th>
              <th scope="col">Round</th>
              <th scope="col">Repository</th>
              <th scope="col">Started</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td>
                  <a className="mono" href={href(`/runs/${r.id}`)}>
                    {shortId(r.id)}
                  </a>
                </td>
                <td>
                  <RunStatusBadge status={r.status} />
                </td>
                <td>{r.stage}</td>
                <td className="ab-num">{r.round}</td>
                <td className="mono">{r.request.repoPath}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
