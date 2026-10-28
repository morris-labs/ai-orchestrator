// Layout for the data-flow diagram: one column per stage, one lane per
// vendor plus a pipeline lane for stage-level endpoints. Pure geometry, so the
// component only draws.
import type { FlowEndpoint, Stage, Vendor } from "@agentbox/contracts";
import type { FlowEdge } from "./model.js";
import { VENDORS } from "./tokens.js";

/** Stage columns in pipeline order. `done` is not a place items flow to. */
export const FLOW_STAGES: readonly Stage[] = [
  "preflight",
  "group",
  "find",
  "merge",
  "verify",
  "sweep",
  "fix",
  "gate",
  "confirm",
  "push",
  "poll",
  "import",
];

export type Lane = Vendor | "pipeline";
export const LANES: readonly Lane[] = ["pipeline", ...VENDORS];

export const FLOW_GEOMETRY = {
  left: 92,
  top: 34,
  colWidth: 78,
  laneHeight: 52,
  nodeRadius: 7,
} as const;

export function laneOf(endpoint: FlowEndpoint): Lane {
  return endpoint.vendor ?? "pipeline";
}

export function nodePosition(stage: Stage, lane: Lane): { x: number; y: number } {
  const col = Math.max(0, FLOW_STAGES.indexOf(stage));
  const row = LANES.indexOf(lane);
  return {
    x: FLOW_GEOMETRY.left + col * FLOW_GEOMETRY.colWidth + FLOW_GEOMETRY.colWidth / 2,
    y: FLOW_GEOMETRY.top + row * FLOW_GEOMETRY.laneHeight + FLOW_GEOMETRY.laneHeight / 2,
  };
}

export function diagramSize(): { width: number; height: number } {
  return {
    width: FLOW_GEOMETRY.left + FLOW_STAGES.length * FLOW_GEOMETRY.colWidth + 8,
    height: FLOW_GEOMETRY.top + LANES.length * FLOW_GEOMETRY.laneHeight + 8,
  };
}

/**
 * The SVG path of an edge: a horizontal S-curve between two nodes, or an arc
 * above the lane when both ends share a column.
 */
export function edgePath(edge: Pick<FlowEdge, "from" | "to">): string {
  const a = nodePosition(edge.from.stage, laneOf(edge.from));
  const b = nodePosition(edge.to.stage, laneOf(edge.to));
  if (a.x === b.x) {
    const bulge = FLOW_GEOMETRY.colWidth * 0.45;
    return `M${a.x},${a.y} C${a.x + bulge},${a.y} ${b.x + bulge},${b.y} ${b.x},${b.y}`;
  }
  const mid = (a.x + b.x) / 2;
  return `M${a.x},${a.y} C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`;
}

/** Where an edge's count label sits. */
export function edgeLabelPoint(edge: Pick<FlowEdge, "from" | "to">): { x: number; y: number } {
  const a = nodePosition(edge.from.stage, laneOf(edge.from));
  const b = nodePosition(edge.to.stage, laneOf(edge.to));
  if (a.x === b.x) return { x: a.x + FLOW_GEOMETRY.colWidth * 0.4, y: (a.y + b.y) / 2 };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6 };
}

/** The nodes an edge set touches, deduplicated, as `stage:lane` keys. */
export function usedNodes(
  edges: readonly Pick<FlowEdge, "from" | "to">[],
): Array<{ stage: Stage; lane: Lane }> {
  const seen = new Map<string, { stage: Stage; lane: Lane }>();
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      const lane = laneOf(end);
      seen.set(`${end.stage}:${lane}`, { stage: end.stage, lane });
    }
  }
  return [...seen.values()];
}
