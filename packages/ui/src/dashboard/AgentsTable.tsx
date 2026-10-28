// Agents: one row per agent call with a live elapsed time, and the count of
// running agents per vendor.
import { useEffect, useState } from "react";
import type { AgentView } from "./model.js";
import { agentElapsed, formatCount, formatDuration, runningPerVendor } from "./selectors.js";
import { VENDOR_LABELS, VENDORS, vendorColor } from "./tokens.js";

/** Re-renders every `ms` while `active`, and returns the current time. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function AgentsTable({
  agents,
  title = "Agents",
  limit = 50,
  now: fixedNow,
}: {
  agents: readonly AgentView[];
  title?: string;
  limit?: number;
  /** A fixed clock for tests. */
  now?: number;
}) {
  const anyRunning = agents.some((a) => a.finishedAt === null);
  const ticking = useNow(anyRunning && fixedNow === undefined);
  const now = fixedNow ?? ticking;
  const counts = runningPerVendor(agents);
  return (
    <section className="ab-card" aria-labelledby="ab-agents-title">
      <header className="ab-card-head">
        <h3 id="ab-agents-title">{title}</h3>
        <ul className="ab-legend" aria-label="Running agents per vendor">
          {VENDORS.map((v) => (
            <li key={v}>
              <span className="ab-key-rect" style={{ background: vendorColor(v) }} />
              {VENDOR_LABELS[v]} <strong className="ab-num">{counts[v]}</strong> running
            </li>
          ))}
        </ul>
      </header>
      {agents.length === 0 ? (
        <p className="ab-empty">No agent has started.</p>
      ) : (
        <div className="ab-table-wrap">
          <table className="ab-table">
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Model</th>
                <th scope="col">Role</th>
                <th scope="col">Group</th>
                <th scope="col">Round</th>
                <th scope="col">Elapsed</th>
                <th scope="col">Tokens in / out</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {agents.slice(0, limit).map((a) => (
                <tr key={`${a.runId}/${a.agentId}`}>
                  <td>
                    <span className="ab-key-rect" style={{ background: vendorColor(a.vendor) }} />
                    {VENDOR_LABELS[a.vendor]}
                  </td>
                  <td className="ab-mono">{a.model}</td>
                  <td>{a.role}</td>
                  <td>{a.groupId ?? "Whole diff"}</td>
                  <td className="ab-num">{a.round}</td>
                  <td className="ab-num">{formatDuration(agentElapsed(a, now))}</td>
                  <td className="ab-num">
                    {a.tokens ? `${formatCount(a.tokens.in)} / ${formatCount(a.tokens.out)}` : "–"}
                  </td>
                  <td>
                    {a.finishedAt === null ? (
                      <span className="ab-status ab-tone-accent">◐ Running</span>
                    ) : a.outcome === "ok" ? (
                      <span className="ab-status ab-tone-good">✓ Done</span>
                    ) : (
                      <span className="ab-status ab-tone-serious">▲ {a.outcome}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
