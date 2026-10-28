// A titled card that holds a chart and its table view. The table keeps every
// value reachable without hovering and without telling series apart by color.
import { useId, useState, type ReactNode } from "react";

export interface ChartCardProps {
  title: string;
  subtitle?: string;
  /** The table view; the toggle appears only when it is given. */
  table?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ChartCard({ title, subtitle, table, children, className }: ChartCardProps) {
  const [showTable, setShowTable] = useState(false);
  const id = useId();
  return (
    <section className={`ab-card ${className ?? ""}`} aria-labelledby={id}>
      <header className="ab-card-head">
        <div>
          <h3 id={id}>{title}</h3>
          {subtitle ? <p className="ab-sub">{subtitle}</p> : null}
        </div>
        {table ? (
          <button
            type="button"
            className="ab-link-button"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? "Chart" : "Table"}
          </button>
        ) : null}
      </header>
      {showTable && table ? table : children}
    </section>
  );
}

export interface TooltipRow {
  key: string;
  color?: string;
  label: string;
  value: string;
}

/** The hover readout: values lead, series names follow, keyed by a short line. */
export function Tooltip({
  x,
  y,
  title,
  rows,
}: {
  /** Left edge, in pixels or a CSS length. */
  x: number | string;
  y: number | string;
  title: string;
  rows: readonly TooltipRow[];
}) {
  return (
    <div className="ab-tooltip" role="status" style={{ left: x, top: y }}>
      <div className="ab-tooltip-title">{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="ab-tooltip-row">
          {r.color ? <span className="ab-key-line" style={{ background: r.color }} /> : null}
          <strong>{r.value}</strong>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A legend that mirrors the mark: a line for lines, a square for bars. */
export function Legend({
  items,
  mark,
}: {
  items: ReadonlyArray<{ key: string; label: string; color: string }>;
  mark: "line" | "rect";
}) {
  return (
    <ul className="ab-legend" aria-label="Legend">
      {items.map((i) => (
        <li key={i.key}>
          <span
            className={mark === "line" ? "ab-key-line" : "ab-key-rect"}
            style={{ background: i.color }}
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
