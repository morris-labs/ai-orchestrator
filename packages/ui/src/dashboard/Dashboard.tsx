// The infrastructure dashboard: fleet, data flow, agents, usage, and run
// health. It renders a `DashboardState` that the caller builds from the
// event stream with `applyEvent()`, plus the usage route's forecasts.
import { useState } from "react";
import { AgentsTable } from "./AgentsTable.js";
import { FleetPanel } from "./FleetPanel.js";
import { FlowDiagram } from "./FlowDiagram.js";
import type { DashboardState } from "./model.js";
import { RunHealth } from "./RunHealth.js";
import {
  agentRows,
  fleetRows,
  focusRunId,
  usageSeries,
  type VendorUsageInfo,
} from "./selectors.js";
import { UsageChart } from "./UsageChart.js";

export interface DashboardProps {
  state: DashboardState;
  usageInfo?: readonly VendorUsageInfo[];
  onOpenRun?: (runId: string) => void;
  /** Connection state of the event stream, shown in the header. */
  connection?: "connecting" | "open" | "closed";
  /** A fixed clock for tests. */
  now?: number;
}

export function Dashboard({ state, usageInfo = [], onOpenRun, connection, now }: DashboardProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const runIds = Object.keys(state.runs).sort().reverse();
  const runId = picked && state.runs[picked] ? picked : focusRunId(state);
  const run = runId ? (state.runs[runId] ?? null) : null;
  const flows = Object.values(state.flows).filter((e) => runId === null || e.runId === runId);
  return (
    <div className="ab-dashboard">
      <div className="ab-filter-row">
        <label>
          Run{" "}
          <select
            value={runId ?? ""}
            onChange={(e) => setPicked(e.target.value || null)}
            aria-label="Run to show in data flow and run health"
          >
            {runIds.length === 0 ? <option value="">No runs</option> : null}
            {runIds.map((id) => {
              const r = state.runs[id]!;
              return (
                <option key={id} value={id}>
                  {id.slice(-6)} {r.run ? `(${r.run.status.replace("_", " ")})` : ""}
                </option>
              );
            })}
          </select>
        </label>
        {runId && onOpenRun ? (
          <button type="button" className="ab-link-button" onClick={() => onOpenRun(runId)}>
            Open run
          </button>
        ) : null}
        {connection ? (
          <span
            className={`ab-status ab-tone-${connection === "open" ? "good" : connection === "connecting" ? "warning" : "critical"}`}
          >
            {connection === "open"
              ? "● Live"
              : connection === "connecting"
                ? "◐ Connecting"
                : "✕ Disconnected"}
          </span>
        ) : null}
        <span className="ab-muted ab-small">{state.eventCount} events</span>
      </div>
      <FleetPanel rows={fleetRows(state)} onOpenRun={onOpenRun} />
      <FlowDiagram edges={flows} activeStage={run?.stage ?? null} />
      <AgentsTable agents={agentRows(state)} now={now} />
      <UsageChart series={usageSeries(state, usageInfo)} now={now} />
      <RunHealth run={run} />
    </div>
  );
}
