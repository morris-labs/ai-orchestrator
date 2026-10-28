// Usage over time: one small chart per vendor account against its ceiling,
// with the window's reset time and the forecast of when the ceiling is
// reached. Vendors measure different things, so each gets its own chart
// instead of sharing an axis.
import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChartCard, Tooltip } from "./ChartCard.js";
import { linearScale, nearestIndex, niceTicks } from "./scale.js";
import { formatPercent, type UsageSeries } from "./selectors.js";
import { VENDOR_LABELS, vendorColor } from "./tokens.js";

const W = 360;
const H = 150;
const M = { top: 12, right: 44, bottom: 22, left: 36 };

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function windowLabel(s: UsageSeries): string {
  return s.window === "month" ? "monthly spend" : `${s.window} window`;
}

function UsagePanel({ series }: { series: UsageSeries }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = series.points;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const xMaxCandidates = [last.time, series.resetAt ?? 0, series.forecastAt ?? 0];
  const xMax = Math.max(...xMaxCandidates, first.time + 60_000);
  const x = linearScale([first.time, xMax], [M.left, W - M.right]);
  const yMax = Math.max(1, ...pts.map((p) => p.utilization), series.ceiling) * 1.05;
  const y = linearScale([0, yMax], [H - M.bottom, M.top]);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time)},${y(p.utilization)}`).join("");
  const area = `${line}L${x(last.time)},${y(0)}L${x(first.time)},${y(0)}Z`;
  const color = vendorColor(series.vendor);
  const over = last.utilization >= series.ceiling;
  const xs = pts.map((p) => x(p.time));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / (rect.width || W)) * W;
    setHover(nearestIndex(xs, px));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? pts.length) - 1));
    else if (e.key === "ArrowRight") setHover((h) => Math.min(pts.length - 1, (h ?? -1) + 1));
    else if (e.key === "Escape") setHover(null);
  };
  const hp = hover === null ? null : pts[hover]!;

  return (
    <figure className="ab-usage-panel">
      <figcaption>
        <span className="ab-key-line" style={{ background: color }} />
        <strong>{VENDOR_LABELS[series.vendor]}</strong>{" "}
        <span className="ab-muted">
          {series.account}, {windowLabel(series)}
        </span>
        <span className={`ab-status ab-tone-${over ? "critical" : "good"}`}>
          {over ? "▲ Over ceiling" : "✓ Under ceiling"}
        </span>
      </figcaption>
      <div className="ab-chart-box">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          tabIndex={0}
          aria-label={`${VENDOR_LABELS[series.vendor]} usage ${formatPercent(last.utilization)}, ceiling ${formatPercent(series.ceiling)}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {niceTicks(0, yMax, 4).map((t) => (
            <g key={t}>
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className="ab-grid" />
              <text x={M.left - 6} y={y(t) + 3} textAnchor="end" className="ab-tick">
                {formatPercent(t)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} className="ab-axis" />
          <text x={M.left} y={H - 6} className="ab-tick">
            {formatClock(first.time)}
          </text>
          <text x={W - M.right} y={H - 6} textAnchor="end" className="ab-tick">
            {formatClock(xMax)}
          </text>
          <line
            x1={M.left}
            x2={W - M.right}
            y1={y(series.ceiling)}
            y2={y(series.ceiling)}
            className="ab-ceiling"
          />
          <text x={W - M.right + 4} y={y(series.ceiling) + 3} className="ab-ref-label">
            Ceiling
          </text>
          {series.resetAt !== null && series.resetAt <= xMax ? (
            <g>
              <line
                x1={x(series.resetAt)}
                x2={x(series.resetAt)}
                y1={M.top}
                y2={H - M.bottom}
                className="ab-ref"
              />
              <text
                x={x(series.resetAt) - 3}
                y={M.top + 8}
                textAnchor="end"
                className="ab-ref-label"
              >
                Resets {formatClock(series.resetAt)}
              </text>
            </g>
          ) : null}
          <path d={area} fill={color} fillOpacity={0.1} />
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {series.forecastAt !== null && series.forecastAt > last.time ? (
            <g>
              <line
                x1={x(last.time)}
                y1={y(last.utilization)}
                x2={x(series.forecastAt)}
                y2={y(series.ceiling)}
                stroke={color}
                strokeWidth={2}
                strokeOpacity={0.4}
              />
              <circle
                cx={x(series.forecastAt)}
                cy={y(series.ceiling)}
                r={4}
                fill={color}
                stroke="var(--ab-surface)"
                strokeWidth={2}
              />
            </g>
          ) : null}
          <circle
            cx={x(last.time)}
            cy={y(last.utilization)}
            r={4}
            fill={color}
            stroke="var(--ab-surface)"
            strokeWidth={2}
          />
          {hp ? (
            <g>
              <line
                x1={x(hp.time)}
                x2={x(hp.time)}
                y1={M.top}
                y2={H - M.bottom}
                className="ab-crosshair"
              />
              <circle
                cx={x(hp.time)}
                cy={y(hp.utilization)}
                r={4}
                fill={color}
                stroke="var(--ab-surface)"
                strokeWidth={2}
              />
            </g>
          ) : null}
        </svg>
        {hp ? (
          <Tooltip
            x={`${(x(hp.time) / W) * 100}%`}
            y={0}
            title={formatClock(hp.time)}
            rows={[
              { key: "u", color, label: "used", value: formatPercent(hp.utilization) },
              { key: "c", label: "ceiling", value: formatPercent(series.ceiling) },
            ]}
          />
        ) : null}
      </div>
      <p className="ab-small ab-muted">
        Now <strong className="ab-text">{formatPercent(last.utilization)}</strong> of the limit.{" "}
        {series.forecastAt !== null
          ? `Reaches the ceiling about ${formatClock(series.forecastAt)}${series.serverForecast ? "" : " (local estimate)"}.`
          : "Stays under the ceiling at this rate."}{" "}
        {series.resetAt !== null ? `Window resets ${formatClock(series.resetAt)}.` : ""}
      </p>
    </figure>
  );
}

export function UsageChart({ series }: { series: readonly UsageSeries[] }) {
  const table = (
    <div className="ab-table-wrap">
      <table className="ab-table">
        <thead>
          <tr>
            <th scope="col">Vendor</th>
            <th scope="col">Account</th>
            <th scope="col">Window</th>
            <th scope="col">Used</th>
            <th scope="col">Ceiling</th>
            <th scope="col">Forecast</th>
            <th scope="col">Resets</th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => {
            const last = s.points[s.points.length - 1]!;
            return (
              <tr key={s.key}>
                <td>{VENDOR_LABELS[s.vendor]}</td>
                <td>{s.account}</td>
                <td>{s.window}</td>
                <td className="ab-num">{formatPercent(last.utilization)}</td>
                <td className="ab-num">{formatPercent(s.ceiling)}</td>
                <td className="ab-num">
                  {s.forecastAt !== null ? formatClock(s.forecastAt) : "–"}
                </td>
                <td className="ab-num">{s.resetAt !== null ? formatClock(s.resetAt) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  return (
    <ChartCard
      title="Usage against ceilings"
      subtitle="Combined by account across every container."
      table={series.length > 0 ? table : undefined}
    >
      {series.length === 0 ? (
        <p className="ab-empty">No usage sample yet.</p>
      ) : (
        <div className="ab-multiples">
          {series.map((s) => (
            <UsagePanel key={s.key} series={s} />
          ))}
        </div>
      )}
    </ChartCard>
  );
}
