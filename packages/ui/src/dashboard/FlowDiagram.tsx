// The data-flow diagram: pipeline stages as columns and a lane per vendor.
// Each `handoff` event restarts a pulse along its edge, labeled with the
// item count. Motion stops for readers who ask for reduced motion.
import { useEffect, useState } from "react";
import type { Stage } from "@agentbox/contracts";
import { ChartCard } from "./ChartCard.js";
import {
  FLOW_GEOMETRY,
  FLOW_STAGES,
  LANES,
  diagramSize,
  edgeLabelPoint,
  edgePath,
  laneOf,
  nodePosition,
  usedNodes,
  type Lane,
} from "./flow.js";
import type { FlowEdge } from "./model.js";
import { VENDOR_LABELS, vendorColor } from "./tokens.js";

function laneLabel(lane: Lane): string {
  return lane === "pipeline" ? "Pipeline" : VENDOR_LABELS[lane];
}

function laneColor(lane: Lane): string {
  return lane === "pipeline" ? "var(--ab-series-neutral)" : vendorColor(lane);
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

export function FlowDiagram({
  edges,
  activeStage,
}: {
  edges: readonly FlowEdge[];
  /** The focused run's stage, highlighted in the header. */
  activeStage: Stage | null;
}) {
  const reduced = useReducedMotion();
  const { width, height } = diagramSize();
  const nodes = usedNodes(edges);
  const table = (
    <div className="ab-table-wrap">
      <table className="ab-table">
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Artifact</th>
            <th scope="col">Last handoff</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((e) => (
            <tr key={e.key}>
              <td>
                {e.from.stage} ({laneLabel(laneOf(e.from))})
              </td>
              <td>
                {e.to.stage} ({laneLabel(laneOf(e.to))})
              </td>
              <td>{e.artifact}</td>
              <td className="ab-num">{e.last}</td>
              <td className="ab-num">{e.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <ChartCard
      title="Data flow"
      subtitle="Stages left to right, one lane per vendor. Edges pulse on each handoff."
      table={table}
      className="ab-flow-card"
    >
      <div className="ab-scroll-x">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={`Data flow with ${edges.length} edges`}
          className="ab-flow"
        >
          {FLOW_STAGES.map((stage, i) => {
            const x = FLOW_GEOMETRY.left + i * FLOW_GEOMETRY.colWidth;
            const active = stage === activeStage;
            return (
              <g key={stage}>
                {active ? (
                  <rect
                    x={x + 2}
                    y={FLOW_GEOMETRY.top - 4}
                    width={FLOW_GEOMETRY.colWidth - 4}
                    height={LANES.length * FLOW_GEOMETRY.laneHeight + 4}
                    rx={4}
                    className="ab-flow-active-col"
                  />
                ) : null}
                <text
                  x={x + FLOW_GEOMETRY.colWidth / 2}
                  y={FLOW_GEOMETRY.top - 12}
                  textAnchor="middle"
                  className={active ? "ab-flow-stage ab-flow-stage-active" : "ab-flow-stage"}
                >
                  {stage}
                </text>
              </g>
            );
          })}
          {LANES.map((lane, i) => {
            const y = FLOW_GEOMETRY.top + i * FLOW_GEOMETRY.laneHeight;
            return (
              <g key={lane}>
                <line
                  x1={FLOW_GEOMETRY.left}
                  x2={width - 8}
                  y1={y + FLOW_GEOMETRY.laneHeight}
                  y2={y + FLOW_GEOMETRY.laneHeight}
                  className="ab-grid"
                />
                <rect
                  x={6}
                  y={y + FLOW_GEOMETRY.laneHeight / 2 - 5}
                  width={10}
                  height={10}
                  rx={2}
                  fill={laneColor(lane)}
                />
                <text x={22} y={y + FLOW_GEOMETRY.laneHeight / 2 + 4} className="ab-flow-lane">
                  {laneLabel(lane)}
                </text>
              </g>
            );
          })}
          {edges.map((e) => {
            const d = edgePath(e);
            const label = edgeLabelPoint(e);
            const color = laneColor(laneOf(e.to));
            return (
              <g key={e.key} className="ab-flow-edge">
                <title>
                  {`${e.last} ${e.artifact} from ${e.from.stage} (${laneLabel(laneOf(e.from))}) to ${e.to.stage} (${laneLabel(laneOf(e.to))}); ${e.total} in total`}
                </title>
                <path d={d} fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.55} />
                {reduced ? null : (
                  <circle key={e.lastEventId} r={4} fill={color} className="ab-flow-pulse">
                    <animateMotion dur="1.2s" repeatCount="1" fill="freeze" path={d} />
                    <animate attributeName="opacity" values="1;1;0" dur="1.6s" fill="freeze" />
                  </circle>
                )}
                <text x={label.x} y={label.y} textAnchor="middle" className="ab-flow-count">
                  {e.last} {e.artifact}
                </text>
              </g>
            );
          })}
          {nodes.map((n) => {
            const p = nodePosition(n.stage, n.lane);
            return (
              <circle
                key={`${n.stage}:${n.lane}`}
                cx={p.x}
                cy={p.y}
                r={FLOW_GEOMETRY.nodeRadius}
                fill={laneColor(n.lane)}
                className="ab-flow-node"
              />
            );
          })}
        </svg>
      </div>
    </ChartCard>
  );
}
