// The colored status dot of the box table, the project list, and the tabs.
export type DotState = "running" | "stopped" | "known" | "pending";

const colors: Record<DotState, string> = {
  running: "var(--ab-running)",
  stopped: "var(--ab-stopped)",
  known: "var(--ab-known)",
  pending: "var(--ab-pending)",
};

/** A status dot. `decorative` hides it from assistive technology when text next to it says the same. */
export function StatusDot({
  state,
  title,
  decorative,
}: {
  state: DotState;
  title?: string;
  decorative?: boolean;
}) {
  return (
    <span
      className="ab-status-dot"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : (title ?? state)}
      title={title}
      style={{ background: colors[state] }}
    />
  );
}
