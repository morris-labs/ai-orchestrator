// Run health: confirmed findings per round and vendor (the pool draining),
// the funnel from raised to fixed, the overlap rate, and cost per round.
import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChartCard, Legend, Tooltip } from "./ChartCard.js";
import type { RunView } from "./model.js";
import { linearScale, nearestIndex, niceTicks } from "./scale.js";
import {
  formatPercent,
  formatUsd,
  funnel,
  overallOverlap,
  roundPoints,
  type RoundVendorPoint,
} from "./selectors.js";
import { VENDOR_LABELS, VENDORS, vendorColor } from "./tokens.js";

const W = 420;
const H = 170;
const M = { top: 14, right: 64, bottom: 24, left: 32 };

function useHover(count: number) {
  const [hover, setHover] = useState<number | null>(null);
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? count) - 1));
    else if (e.key === "ArrowRight") setHover((h) => Math.min(count - 1, (h ?? -1) + 1));
    else if (e.key === "Escape") setHover(null);
  };
  return { hover, setHover, onKey };
}

function svgX(e: PointerEvent<SVGSVGElement>): number {
  const rect = e.currentTarget.getBoundingClientRect();
  return ((e.clientX - rect.left) / (rect.width || W)) * W;
}

function ConfirmedChart({ points }: { points: readonly RoundVendorPoint[] }) {
  const { hover, setHover, onKey } = useHover(points.length);
  const rounds = points.map((p) => p.round);
  const x = linearScale(
    [Math.min(...rounds), Math.max(Math.max(...rounds), Math.min(...rounds) + 1)],
    [M.left, W - M.right],
  );
  const yMax = Math.max(1, ...points.flatMap((p) => VENDORS.map((v) => p.confirmed[v])));
  const y = linearScale([0, yMax * 1.1], [H - M.bottom, M.top]);
  const xs = points.map((p) => x(p.round));
  const hp = hover === null ? null : points[hover]!;
  const lastPoint = points[points.length - 1]!;
  return (
    <div className="ab-chart-box">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        tabIndex={0}
        aria-label="Confirmed findings per round and vendor"
        onPointerMove={(e) => setHover(nearestIndex(xs, svgX(e)))}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {niceTicks(0, yMax * 1.1, 4).map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className="ab-grid" />
            <text x={M.left - 6} y={y(t) + 3} textAnchor="end" className="ab-tick">
              {t}
            </text>
          </g>
        ))}
        <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} className="ab-axis" />
        {points.map((p) => (
          <text key={p.round} x={x(p.round)} y={H - 8} textAnchor="middle" className="ab-tick">
            {p.round}
          </text>
        ))}
        {hp ? (
          <line
            x1={x(hp.round)}
            x2={x(hp.round)}
            y1={M.top}
            y2={H - M.bottom}
            className="ab-crosshair"
          />
        ) : null}
        {VENDORS.map((v) => {
          const d = points
            .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.round)},${y(p.confirmed[v])}`)
            .join("");
          return (
            <g key={v}>
              <path
                d={d}
                fill="none"
                stroke={vendorColor(v)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle
                cx={x(lastPoint.round)}
                cy={y(lastPoint.confirmed[v])}
                r={4}
                fill={vendorColor(v)}
                stroke="var(--ab-surface)"
                strokeWidth={2}
              />
              {hp ? (
                <circle
                  cx={x(hp.round)}
                  cy={y(hp.confirmed[v])}
                  r={4}
                  fill={vendorColor(v)}
                  stroke="var(--ab-surface)"
                  strokeWidth={2}
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      {hp ? (
        <Tooltip
          x={`${(x(hp.round) / W) * 100}%`}
          y={0}
          title={`Round ${hp.round}${hp.live ? " (in progress)" : ""}`}
          rows={VENDORS.map((v) => ({
            key: v,
            color: vendorColor(v),
            label: VENDOR_LABELS[v],
            value: String(hp.confirmed[v]),
          }))}
        />
      ) : null}
    </div>
  );
}

function CostChart({ points }: { points: readonly RoundVendorPoint[] }) {
  const { hover, setHover, onKey } = useHover(points.length);
  const band = (W - M.left - M.right) / Math.max(points.length, 1);
  const barW = Math.min(24, band - 2);
  const yMax = Math.max(0.01, ...points.map((p) => p.costUsd));
  const y = linearScale([0, yMax * 1.15], [H - M.bottom, M.top]);
  const cx = (i: number) => M.left + band * i + band / 2;
  const maxIdx = points.reduce((best, p, i) => (p.costUsd > points[best]!.costUsd ? i : best), 0);
  const hp = hover === null ? null : points[hover]!;
  return (
    <div className="ab-chart-box">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        tabIndex={0}
        aria-label="Cost per round in US dollars"
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        onPointerLeave={() => setHover(null)}
      >
        {niceTicks(0, yMax * 1.15, 3).map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className="ab-grid" />
            <text x={M.left - 6} y={y(t) + 3} textAnchor="end" className="ab-tick">
              {formatUsd(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const top = y(p.costUsd);
          const h = Math.max(0, y(0) - top);
          const r = Math.min(4, h);
          const x0 = cx(i) - barW / 2;
          // Rounded data end, square at the baseline.
          const d = `M${x0},${y(0)}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + barW - r}Q${x0 + barW},${top} ${x0 + barW},${top + r}V${y(0)}Z`;
          return (
            <g key={p.round} onPointerEnter={() => setHover(i)}>
              <rect
                x={cx(i) - band / 2}
                y={M.top}
                width={band}
                height={y(0) - M.top}
                fill="transparent"
              />
              <path
                d={d}
                fill="var(--ab-accent)"
                fillOpacity={hover === i ? 0.8 : p.live ? 0.5 : 1}
              />
              <text x={cx(i)} y={H - 8} textAnchor="middle" className="ab-tick">
                {p.round}
              </text>
              {i === maxIdx ? (
                <text x={cx(i)} y={top - 4} textAnchor="middle" className="ab-value-label">
                  {formatUsd(p.costUsd)}
                </text>
              ) : null}
            </g>
          );
        })}
        <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} className="ab-axis" />
      </svg>
      {hp ? (
        <Tooltip
          x={`${(cx(hover!) / W) * 100}%`}
          y={0}
          title={`Round ${hp.round}${hp.live ? " (in progress)" : ""}`}
          rows={[{ key: "c", label: "cost", value: formatUsd(hp.costUsd) }]}
        />
      ) : null}
    </div>
  );
}

function FunnelBars({ run }: { run: RunView }) {
  const f = funnel(run);
  const steps = [
    { label: "Raised", value: f.raised },
    { label: "Merged", value: f.merged },
    { label: "Confirmed", value: f.confirmed },
    { label: "Fixed", value: f.fixed },
  ];
  const max = Math.max(1, f.raised);
  return (
    <ol className="ab-funnel" aria-label="Finding funnel">
      {steps.map((s, i) => (
        <li key={s.label}>
          <span className="ab-funnel-label">{s.label}</span>
          <span className="ab-funnel-track">
            <span
              className="ab-funnel-bar"
              style={{ width: `${(s.value / max) * 100}%`, background: `var(--ab-seq-${4 - i})` }}
            />
          </span>
          <strong className="ab-num">{s.value}</strong>
        </li>
      ))}
    </ol>
  );
}

export function RunHealth({ run }: { run: RunView | null }) {
  if (!run) {
    return (
      <ChartCard title="Run health">
        <p className="ab-empty">No run yet.</p>
      </ChartCard>
    );
  }
  const points = roundPoints(run);
  const overlap = overallOverlap(run);
  const latestOverlap = run.rounds[run.rounds.length - 1]?.overlapRate ?? null;
  const table = (
    <div className="ab-table-wrap">
      <table className="ab-table">
        <thead>
          <tr>
            <th scope="col">Round</th>
            {VENDORS.map((v) => (
              <th key={v} scope="col">
                {VENDOR_LABELS[v]} confirmed
              </th>
            ))}
            <th scope="col">Overlap</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.round}>
              <td className="ab-num">
                {p.round}
                {p.live ? " (in progress)" : ""}
              </td>
              {VENDORS.map((v) => (
                <td key={v} className="ab-num">
                  {p.confirmed[v]}
                </td>
              ))}
              <td className="ab-num">{p.live ? "–" : formatPercent(p.overlapRate)}</td>
              <td className="ab-num">{formatUsd(p.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <ChartCard
      title="Run health"
      subtitle={`Run ${run.runId.slice(-6)}${run.run ? `, ${run.run.status.replace("_", " ")}` : ""}`}
      table={points.length > 0 ? table : undefined}
      className="ab-health"
    >
      <div className="ab-health-grid">
        <div>
          <h4>Confirmed findings per round</h4>
          <Legend
            mark="line"
            items={VENDORS.map((v) => ({ key: v, label: VENDOR_LABELS[v], color: vendorColor(v) }))}
          />
          {points.length > 0 ? (
            <ConfirmedChart points={points} />
          ) : (
            <p className="ab-empty">No round has finished.</p>
          )}
        </div>
        <div>
          <h4>Funnel</h4>
          <FunnelBars run={run} />
          <div className="ab-tiles">
            <div className="ab-tile">
              <span className="ab-tile-label">Overlap rate, whole run</span>
              <span className="ab-tile-value">
                {overlap === null ? "–" : formatPercent(overlap)}
              </span>
            </div>
            <div className="ab-tile">
              <span className="ab-tile-label">Overlap rate, last round</span>
              <span className="ab-tile-value">
                {latestOverlap === null ? "–" : formatPercent(latestOverlap)}
              </span>
            </div>
          </div>
        </div>
        <div>
          <h4>Cost per round</h4>
          {points.length > 0 ? (
            <CostChart points={points} />
          ) : (
            <p className="ab-empty">No cost recorded.</p>
          )}
        </div>
      </div>
    </ChartCard>
  );
}
