// The colored status dot of the box table, the project list, and the tabs.
export type DotState = "running" | "stopped" | "known" | "pending";

const colors: Record<DotState, string> = {
  running: "var(--ab-running)",
  stopped: "var(--ab-stopped)",
  known: "var(--ab-known)",
  pending: "var(--ab-pending)",
};

export function StatusDot({ state, title }: { state: DotState; title?: string }) {
  return (
    <span
      className="ab-status-dot"
      role="img"
      aria-label={title ?? state}
      title={title}
      style={{ background: colors[state] }}
    />
  );
}
