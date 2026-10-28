// Small shared pieces for the screens. At merge these can move to the shared
// components in `packages/ui`.
import type { ReactNode } from "react";
import type { RunStatus } from "@agentbox/contracts";

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="banner banner-error">
      ✕ {message}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

const STATUS: Record<RunStatus, { icon: string; tone: string; label: string }> = {
  pending: { icon: "○", tone: "muted", label: "Pending" },
  running: { icon: "◐", tone: "accent", label: "Running" },
  paused: { icon: "‖", tone: "warning", label: "Paused" },
  waiting_decision: { icon: "▲", tone: "serious", label: "Needs your decision" },
  finished: { icon: "✓", tone: "good", label: "Finished" },
  failed: { icon: "✕", tone: "critical", label: "Failed" },
  cancelled: { icon: "■", tone: "muted", label: "Cancelled" },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status];
  return (
    <span className={`ab-status ab-tone-${s.tone}`} data-status={status}>
      {s.icon} {s.label}
    </span>
  );
}

export function shortId(id: string): string {
  return id.slice(-6);
}

/** Renders a unified diff with added and removed lines marked. */
export function DiffView({ diff, label }: { diff: string | null; label: string }) {
  if (!diff) return <p className="muted">No diff.</p>;
  return (
    <pre className="diff" aria-label={label}>
      {diff.split("\n").map((line, i) => {
        const cls =
          line.startsWith("+++") || line.startsWith("---")
            ? "diff-file"
            : line.startsWith("@@")
              ? "diff-hunk"
              : line.startsWith("+")
                ? "diff-add"
                : line.startsWith("-")
                  ? "diff-del"
                  : "";
        return (
          <span key={i} className={cls}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}
