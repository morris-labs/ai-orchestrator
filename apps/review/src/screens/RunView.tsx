// The run view: stepper, round counter, roles with manual assignment,
// profile switch, controls, the decision panel, round summaries, the run's
// live agents, and cost per round.
import {
  ProfileSchema,
  RoleSchema,
  type Decision,
  type DecisionOption,
  type Finding,
  type Profile,
  type Role,
  type RoundSummary,
  type RunState,
  type Vendor,
} from "@aio/contracts";
import {
  AgentsTable,
  VENDOR_LABELS,
  VENDORS,
  agentRows,
  formatUsd,
  vendorColor,
} from "@aio/ui/dashboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBanner, RunStatusBadge, shortId } from "../components/common.js";
import { EventBuffer } from "../state/eventBuffer.js";
import { href } from "../state/router.js";
import { useApiClient, useAnyEvent } from "@aio/ui/hooks";
import { useStore } from "../state/store.js";
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
  const current = (role: Role): Vendor[] => {
    const v = run.roles[role];
    return Array.isArray(v) ? v : [v];
  };
  // Reset the draft only when the run's roles actually change. Resetting from
  // an effect raced a click made before the mount effect flushed: the effect's
  // update landed after the click's and wiped the choice.
  const rolesKey = JSON.stringify(run.roles);
  const initial = () =>
    Object.fromEntries(RoleSchema.options.map((r) => [r, current(r)])) as Record<Role, Vendor[]>;
  const [draft, setDraft] = useState<Record<Role, Vendor[]>>(initial);
  const [draftKey, setDraftKey] = useState(rolesKey);
  if (draftKey !== rolesKey) {
    setDraftKey(rolesKey);
    setDraft(initial());
  }
  return (
    <table className="ab-table" aria-label="Roles">
      <thead>
        <tr>
          <th scope="col">Role</th>
          {VENDORS.map((v) => (
            <th key={v} scope="col">
              <span className="ab-key-rect" style={{ background: vendorColor(v) }} />
              {VENDOR_LABELS[v]}
            </th>
          ))}
          <th scope="col">
            <span className="visually-hidden">Apply</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {RoleSchema.options.map((role) => {
          const multi = role === "reviewer";
          const chosen = draft[role];
          const changed = chosen.slice().sort().join() !== current(role).slice().sort().join();
          return (
            <tr key={role}>
              <th scope="row">{role}</th>
              {VENDORS.map((v) => (
                <td key={v}>
                  <input
                    type={multi ? "checkbox" : "radio"}
                    name={`role-${role}`}
                    aria-label={`${role}: ${VENDOR_LABELS[v]}`}
                    checked={chosen.includes(v)}
                    disabled={disabled}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        [role]: multi
                          ? e.target.checked
                            ? [...chosen, v]
                            : chosen.filter((x) => x !== v)
                          : [v],
                      }))
                    }
                  />
                </td>
              ))}
              <td>
                <button
                  type="button"
                  disabled={disabled || !changed || chosen.length === 0}
                  onClick={() => onAssign(role, chosen)}
                >
                  Assign
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function RunView({ runId }: { runId: string }) {
  const api = useApiClient();
  const [run, setRun] = useState<RunState | null>(null);
  const [rounds, setRounds] = useState<RoundSummary[]>([]);
  const [decisionFindings, setDecisionFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const resets = useStore((s) => s.resets);
  const dashboard = useStore((s) => s.dashboard);
  const agents = agentRows(dashboard, runId);

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
            {run.request.pipeline} · {run.request.repoPath} · base {run.request.base}
            {run.baseSha ? ` (${run.baseSha.slice(0, 8)})` : ""} · tip{" "}
            {run.request.tip ?? "checked-out branch"}
            {run.request.readOnly ? " · read-only" : ""}
          </p>
        </div>
        <div className="round-counter" aria-label="Round">
          <span className="tile-label">Round</span>
          <span className="tile-value">
            {run.round} <span className="muted">of {run.request.roundCap}</span>
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
          <select
            value={run.profile}
            disabled={!controls.steer || busy}
            onChange={(e) =>
              void act(() =>
                api.call("runs.profile", { params, body: { profile: e.target.value as Profile } }),
              )
            }
          >
            {ProfileSchema.options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">Changes apply from the next round.</p>
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
