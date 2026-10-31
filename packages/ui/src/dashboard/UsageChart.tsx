// Usage over time: one small chart per vendor account against its ceiling,
// with the window's reset time and the forecast of when the ceiling is
// reached. Vendors measure different things, so each gets its own chart
// instead of sharing an axis.
import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChartCard, Tooltip } from "./ChartCard.js";
import { linearScale, nearestIndex, niceTicks } from "./scale.js";
import { formatPercent, USAGE_SOURCE_LABELS, type UsageSeries } from "./selectors.js";
import { VENDOR_LABELS, vendorColor } from "./tokens.js";

const W = 360;
const H = 150;
const M = { top: 12, right: 44, bottom: 22, left: 36 };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/**
 * A local time for a chart label: `14:00` today, `Tue 14:00` within six
 * days of `now`, else `3 Nov 14:00`. A 7-day window's reset, or a forecast
 * past midnight, then can't pass for a time later today.
 */
export function formatClock(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return clock;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(today)) / DAY_MS);
  if (Math.abs(days) <= 6) return `${WEEKDAYS[d.getDay()]} ${clock}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock}`;
}

function windowLabel(s: UsageSeries): string {
  return s.window === "month" ? "monthly spend" : `${s.window} window`;
}

function UsagePanel({ series, now }: { series: UsageSeries; now?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = series.points;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  // Show the forecast, and the reset when it is near enough not to squeeze
  // the samples into a sliver; the caption always names the reset time.
  const span = Math.max(last.time - first.time, 15 * 60_000);
  const reach = last.time + span * 1.5;
  const xMax = Math.max(
    last.time,
    first.time + 60_000,
    Math.min(series.forecastAt ?? 0, reach),
    Math.min(series.resetAt ?? 0, reach),
  );
  const x = linearScale([first.time, xMax], [M.left, W - M.right]);
  const ceiling = series.ceiling;
  const yMax = Math.max(1, ...pts.map((p) => p.utilization), ceiling ?? 0) * 1.05;
  const y = linearScale([0, yMax], [H - M.bottom, M.top]);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time)},${y(p.utilization)}`).join("");
  const area = `${line}L${x(last.time)},${y(0)}L${x(first.time)},${y(0)}Z`;
  const color = vendorColor(series.vendor);
  const over = ceiling !== null && last.utilization >= ceiling;
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
        {ceiling === null ? (
          <span className="ab-status ab-muted">No ceiling for this window</span>
        ) : (
          <span className={`ab-status ab-tone-${over ? "critical" : "good"}`}>
            {over ? "▲ Over ceiling" : "✓ Under ceiling"}
          </span>
        )}
      </figcaption>
      <div className="ab-chart-box">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          tabIndex={0}
          aria-label={`${VENDOR_LABELS[series.vendor]} usage ${formatPercent(last.utilization)}, ${ceiling === null ? "no ceiling" : `ceiling ${formatPercent(ceiling)}`}`}
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
            {formatClock(first.time, now)}
          </text>
          <text x={W - M.right} y={H - 6} textAnchor="end" className="ab-tick">
            {formatClock(xMax, now)}
          </text>
          {ceiling !== null ? (
            <g>
              <line
                x1={M.left}
                x2={W - M.right}
                y1={y(ceiling)}
                y2={y(ceiling)}
                className="ab-ceiling"
              />
              <text x={W - M.right + 4} y={y(ceiling) + 3} className="ab-ref-label">
                Ceiling
              </text>
            </g>
          ) : null}
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
                Resets {formatClock(series.resetAt, now)}
              </text>
            </g>
          ) : null}
          <path d={area} fill={color} fillOpacity={0.1} />
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeDasharray={series.estimated ? "5 4" : undefined}
            data-estimated={series.estimated || undefined}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {ceiling !== null &&
          series.forecastAt !== null &&
          series.forecastAt > last.time &&
          series.forecastAt <= xMax ? (
            <g>
              <line
                x1={x(last.time)}
                y1={y(last.utilization)}
                x2={x(series.forecastAt)}
                y2={y(ceiling)}
                stroke={color}
                strokeWidth={2}
                strokeOpacity={0.4}
              />
              <circle
                cx={x(series.forecastAt)}
                cy={y(ceiling)}
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
            title={formatClock(hp.time, now)}
            rows={[
              { key: "u", color, label: "used", value: formatPercent(hp.utilization) },
              {
                key: "s",
                label: "source",
                value: USAGE_SOURCE_LABELS[hp.source],
              },
              {
                key: "c",
                label: "ceiling",
                value: ceiling === null ? "–" : formatPercent(ceiling),
              },
            ]}
          />
        ) : null}
      </div>
      <p className="ab-small ab-muted">
        Now <strong className="ab-text">{formatPercent(last.utilization)}</strong> of the limit
        {series.estimated ? `, ${USAGE_SOURCE_LABELS[last.source]}` : ""}.{" "}
        {ceiling === null
          ? "The ceiling applies to another window."
          : series.forecastAt !== null
            ? `Reaches the ceiling about ${formatClock(series.forecastAt, now)}${series.serverForecast ? "" : " (local estimate)"}.`
            : "Stays under the ceiling at this rate."}{" "}
        {series.resetAt !== null ? `Window resets ${formatClock(series.resetAt, now)}.` : ""}
      </p>
    </figure>
  );
}

export function UsageChart({
  series,
  now,
}: {
  series: readonly UsageSeries[];
  /** The time labels are relative to; the current time by default. */
  now?: number;
}) {
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
            <th scope="col">Source</th>
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
                <td className="ab-num">{s.ceiling === null ? "–" : formatPercent(s.ceiling)}</td>
                <td className="ab-num">
                  {s.forecastAt !== null ? formatClock(s.forecastAt, now) : "–"}
                </td>
                <td className="ab-num">{s.resetAt !== null ? formatClock(s.resetAt, now) : "–"}</td>
                <td>{USAGE_SOURCE_LABELS[last.source]}</td>
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
            <UsagePanel key={s.key} series={s} now={now} />
          ))}
        </div>
      )}
    </ChartCard>
  );
}
