// Findings browser: filter a run's findings by round, vendor, severity, and
// verdict; open one for its diff, verdict trail, evidence, fix commit, and
// the waive action.
import {
  SeveritySchema,
  VerdictSchema,
  type Finding,
  type RouteOf,
  type RunState,
  type Severity,
  type Vendor,
  type Verdict,
} from "@agentbox/contracts";
import { VENDOR_LABELS, VENDORS } from "@agentbox/ui/dashboard";
import { useEffect, useMemo, useState } from "react";
import { DiffView, ErrorBanner, Field, shortId } from "../components/common.js";
import { href, navigate } from "../state/router.js";
import { useApiClient, useAnyEvent } from "@agentbox/ui/hooks";
import { useStore } from "../state/store.js";
import {
  NO_FILTER,
  canWaive,
  filterFindings,
  findingVendors,
  type FindingFilter,
} from "./findingsModel.js";
import { commitUrl } from "./runModel.js";

type Detail = RouteOf<"findings.get">["response"];

function FindingDetail({
  runId,
  findingId,
  run,
  onChanged,
}: {
  runId: string;
  findingId: string;
  run: RunState | null;
  onChanged: (f: Finding) => void;
}) {
  const api = useApiClient();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // A response for a finding the user has since left must not replace the
    // detail, or Waive acts on a finding other than the one shown.
    let live = true;
    setDetail(null);
    setError(null);
    api.call("findings.get", { params: { runId, findingId } }).then(
      (d) => {
        if (live) setDetail(d);
      },
      (err: unknown) => {
        if (live) setError(err);
      },
    );
    return () => {
      live = false;
    };
  }, [api, runId, findingId]);
  if (!detail) return error ? <ErrorBanner error={error} /> : <p className="muted">Loading…</p>;
  const f = detail.finding;
  const link = f.fixCommit ? commitUrl(run?.prUrl, f.fixCommit) : null;
  async function waive() {
    setBusy(true);
    try {
      // Waive the finding on screen, which is the one the reason was typed for.
      const updated = await api.call("findings.waive", {
        params: { runId, findingId: f.id },
        body: { reason: reason.trim() },
      });
      setDetail((d) => (d ? { ...d, finding: updated } : d));
      onChanged(updated);
      setReason("");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="card finding-detail" aria-label={`Finding ${f.id}`}>
      <ErrorBanner error={error} />
      <h3>
        {f.id} <span className={`sev sev-${f.severity}`}>{f.severity}</span> {f.title}
      </h3>
      <p className="mono small">
        {f.file ?? "No location"}
        {f.lines ? `:${f.lines[0]}-${f.lines[1]}` : ""} · {f.category} · round {f.round} · group{" "}
        {f.groupId ?? "none"}
      </p>
      <dl className="facts">
        {f.symbol ? (
          <>
            <dt>Symbol</dt>
            <dd className="mono">{f.symbol}</dd>
          </>
        ) : null}
        <dt>Verdict</dt>
        <dd>
          {f.verdict}
          {f.verification ? ` (${f.verification})` : ""}
        </dd>
        <dt>Raised by</dt>
        <dd>{[f.reportedBy, ...f.alsoReportedBy].join(", ")}</dd>
        <dt>Introduced</dt>
        <dd>{f.introduced ? "Yes, on this branch" : "No, it exists at the base"}</dd>
        <dt>Origin</dt>
        <dd>
          {f.origin}
          {f.externalRef?.url ? (
            <>
              {" "}
              <a href={f.externalRef.url} target="_blank" rel="noreferrer">
                source
              </a>
            </>
          ) : null}
        </dd>
        <dt>Fix commit</dt>
        <dd>
          {f.fixCommit ? (
            link ? (
              <a href={link} target="_blank" rel="noreferrer" className="mono">
                {f.fixCommit.slice(0, 10)}
              </a>
            ) : (
              <span className="mono">{f.fixCommit.slice(0, 10)}</span>
            )
          ) : (
            "None"
          )}
        </dd>
      </dl>
      <h4>Failure case</h4>
      <p>{f.failureCase}</p>
      <h4>Evidence</h4>
      {f.evidence ? (
        <pre className="evidence">{f.evidence}</pre>
      ) : (
        <p className="muted">None recorded.</p>
      )}
      <h4>Diff</h4>
      <DiffView diff={detail.diff} label="Finding diff" />
      {detail.fixDiff ? (
        <>
          <h4>Fix</h4>
          <DiffView diff={detail.fixDiff} label="Fix diff" />
        </>
      ) : null}
      <h4>Verdict trail</h4>
      {f.history.length === 0 ? (
        <p className="muted">No changes yet.</p>
      ) : (
        <ol className="trail">
          {f.history.map((h, i) => (
            <li key={i}>
              <strong>{h.verdict}</strong> by {h.actor.kind}
              {h.actor.vendor ? ` ${h.actor.vendor}` : ""}
              {h.actor.role ? ` (${h.actor.role})` : ""}
              {h.round ? `, round ${h.round}` : ""} ·{" "}
              <time dateTime={h.time}>{new Date(h.time).toLocaleString()}</time>
              {h.evidence ? <div className="muted small">{h.evidence}</div> : null}
            </li>
          ))}
        </ol>
      )}
      {canWaive(f) ? (
        <div className="waive">
          <Field label="Reason for waiving">
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <button
            type="button"
            disabled={busy || reason.trim() === ""}
            onClick={() => void waive()}
          >
            Waive
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function Findings({ runId, findingId }: { runId: string | null; findingId: string | null }) {
  const api = useApiClient();
  const [runs, setRuns] = useState<RunState[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [filter, setFilter] = useState<FindingFilter>(NO_FILTER);
  const [error, setError] = useState<unknown>(null);
  const resets = useStore((s) => s.resets);

  useEffect(() => {
    api
      .call("runs.list")
      .then(
        (r) => setRuns([...r.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
        setError,
      );
  }, [api, resets]);

  const selectedRun = runId ?? runs[0]?.id ?? null;
  useEffect(() => {
    if (!selectedRun) return;
    // Drop a late list for a run the user has since left.
    let live = true;
    api.call("findings.list", { params: { runId: selectedRun } }).then(
      (r) => {
        if (live) setFindings(r.findings);
      },
      (err: unknown) => {
        if (live) setError(err);
      },
    );
    return () => {
      live = false;
    };
  }, [api, selectedRun, resets]);

  // Another run's findings never show under this run while its list loads.
  const [listedRun, setListedRun] = useState(selectedRun);
  if (listedRun !== selectedRun) {
    setListedRun(selectedRun);
    setFindings([]);
  }

  useAnyEvent((e) => {
    if (e.type === "finding.changed" && e.runId === selectedRun) {
      setFindings((fs) => [...fs.filter((f) => f.id !== e.finding.id), e.finding]);
    }
  });

  const rounds = useMemo(
    () => [...new Set(findings.map((f) => f.round))].sort((a, b) => a - b),
    [findings],
  );
  const shown = filterFindings(findings, filter);
  const run = runs.find((r) => r.id === selectedRun) ?? null;
  const go = (q: Record<string, string | undefined>) =>
    navigate(href("/findings", { run: selectedRun ?? undefined, ...q }));

  return (
    <div className="screen">
      <h2>Findings</h2>
      <ErrorBanner error={error} />
      <div className="filter-row">
        <Field label="Run">
          <select
            value={selectedRun ?? ""}
            onChange={(e) => navigate(href("/findings", { run: e.target.value }))}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {shortId(r.id)} {r.request.repoPath} ({r.status})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Round">
          <select
            value={filter.round ?? ""}
            onChange={(e) =>
              setFilter({ ...filter, round: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">All</option>
            {rounds.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Vendor">
          <select
            value={filter.vendor ?? ""}
            onChange={(e) =>
              setFilter({ ...filter, vendor: (e.target.value || null) as Vendor | null })
            }
          >
            <option value="">All</option>
            {VENDORS.map((v) => (
              <option key={v} value={v}>
                {VENDOR_LABELS[v]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Severity">
          <select
            value={filter.severity ?? ""}
            onChange={(e) =>
              setFilter({ ...filter, severity: (e.target.value || null) as Severity | null })
            }
          >
            <option value="">All</option>
            {SeveritySchema.options.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Verdict">
          <select
            value={filter.verdict ?? ""}
            onChange={(e) =>
              setFilter({ ...filter, verdict: (e.target.value || null) as Verdict | null })
            }
          >
            <option value="">All</option>
            {VerdictSchema.options.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="split">
        <div className="list-pane">
          <p className="muted small">
            {shown.length} of {findings.length} findings
          </p>
          <ul className="finding-list">
            {shown.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className={f.id === findingId ? "finding-row selected" : "finding-row"}
                  aria-current={f.id === findingId ? "true" : undefined}
                  onClick={() => go({ finding: f.id })}
                >
                  <span className={`sev sev-${f.severity}`}>{f.severity}</span>
                  <span className="finding-title">{f.title}</span>
                  <span className="muted small">
                    {f.id} · round {f.round} · {f.verdict} ·{" "}
                    {findingVendors(f)
                      .map((v) => VENDOR_LABELS[v])
                      .join(", ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="detail-pane">
          {selectedRun && findingId ? (
            <FindingDetail
              key={`${selectedRun}/${findingId}`}
              runId={selectedRun}
              findingId={findingId}
              run={run}
              onChanged={(u) => setFindings((fs) => fs.map((f) => (f.id === u.id ? u : f)))}
            />
          ) : (
            <p className="muted">Select a finding.</p>
          )}
        </div>
      </div>
    </div>
  );
}
