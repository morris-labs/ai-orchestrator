// A CPU or memory bar, colored green to red like the Qt details panel.
import { barChunkColor } from "../theme/tokens";

export function ProgressBar({ fraction, label }: { fraction: number; label?: string }) {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <div
      className="ab-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(f * 100)}
      aria-label={label}
    >
      <div
        className="ab-progress-chunk"
        style={{ width: `${f * 100}%`, background: barChunkColor(f) }}
      />
      {label && <div className="ab-progress-label">{label}</div>}
    </div>
  );
}
