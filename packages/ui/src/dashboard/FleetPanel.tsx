// Fleet: one row per project container with its connection state, engine
// version match, active runs and stage, and CPU and memory from
// `container.stats`.
import { useId } from "react";
import type { FleetRow } from "./selectors.js";
import { formatBytes, formatPercent } from "./selectors.js";

const CONNECTION: Record<FleetRow["connection"], { icon: string; label: string; tone: string }> = {
  connected: { icon: "●", label: "Connected", tone: "good" },
  unhealthy: { icon: "▲", label: "Engine not answering", tone: "serious" },
  stopped: { icon: "■", label: "Stopped", tone: "muted" },
  unknown: { icon: "○", label: "Unknown", tone: "muted" },
};

function VersionCell({ matches }: { matches: boolean | null }) {
  if (matches === null) return <span className="ab-status ab-tone-muted">○ Not checked</span>;
  return matches ? (
    <span className="ab-status ab-tone-good">✓ Matches</span>
  ) : (
    <span className="ab-status ab-tone-critical">✕ Mismatch: rebuild the image</span>
  );
}

function Meter({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <span className="ab-muted">–</span>;
  const clamped = Math.max(0, Math.min(1, value));
  const tone = clamped >= 0.9 ? "critical" : clamped >= 0.75 ? "warning" : "accent";
  return (
    <span className="ab-meter" title={label}>
      <span className="ab-meter-track">
        <span className={`ab-meter-fill ab-fill-${tone}`} style={{ width: `${clamped * 100}%` }} />
      </span>
      <span className="ab-num">{label}</span>
    </span>
  );
}

export function FleetPanel({
  rows,
  onOpenRun,
}: {
  rows: readonly FleetRow[];
  onOpenRun?: (runId: string) => void;
}) {
  const titleId = useId();
  return (
    <section className="ab-card" aria-labelledby={titleId}>
      <header className="ab-card-head">
        <h3 id={titleId}>Fleet</h3>
        <p className="ab-sub">{rows.length} containers</p>
      </header>
      {rows.length === 0 ? (
        <p className="ab-empty">
          No container has reported yet. Containers appear with their first stats sample.
        </p>
      ) : (
        <div className="ab-table-wrap">
          <table className="ab-table">
            <thead>
              <tr>
                <th scope="col">Container</th>
                <th scope="col">Connection</th>
                <th scope="col">Engine version</th>
                <th scope="col">Active runs</th>
                <th scope="col">CPU</th>
                <th scope="col">Memory</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const conn = CONNECTION[r.connection];
                return (
                  <tr key={r.container.name}>
                    <td>
                      <div className="ab-mono">{r.container.name}</div>
                      <div className="ab-muted ab-small">{r.container.projectId}</div>
                    </td>
                    <td>
                      <span className={`ab-status ab-tone-${conn.tone}`}>
                        {conn.icon} {conn.label}
                      </span>
                    </td>
                    <td>
                      <VersionCell matches={r.versionMatches} />
                      {r.container.engine?.version ? (
                        <div className="ab-muted ab-small">{r.container.engine.version}</div>
                      ) : null}
                    </td>
                    <td>
                      {r.activeRuns.length === 0 ? (
                        <span className="ab-muted">None</span>
                      ) : (
                        <ul className="ab-plain-list">
                          {r.activeRuns.map((run) => (
                            <li key={run.runId}>
                              <button
                                type="button"
                                className="ab-link-button ab-mono"
                                onClick={() => onOpenRun?.(run.runId)}
                              >
                                {run.runId.slice(-6)}
                              </button>{" "}
                              {run.stage ?? "pending"}, round {run.round}
                              {run.status !== "running" ? ` (${run.status.replace("_", " ")})` : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>
                      <Meter
                        value={
                          r.container.cpuPercent === null ? null : r.container.cpuPercent / 100
                        }
                        label={
                          r.container.cpuPercent === null
                            ? "–"
                            : `${r.container.cpuPercent.toFixed(1)}%`
                        }
                      />
                    </td>
                    <td>
                      <Meter
                        value={r.memFraction}
                        label={`${formatBytes(r.container.memBytes)}${
                          r.memFraction !== null ? ` (${formatPercent(r.memFraction)})` : ""
                        }`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
