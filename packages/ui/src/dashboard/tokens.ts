// Theme tokens for the dashboard. The surfaces, text, borders, and status
// colors come from the shared Agent Box theme (`../theme/tokens`), so the
// dashboard matches the boxes app. The series colors stay the dataviz
// palette: the vendor colors are its first three slots, which pass the
// all-pairs colorblind checks on a dark surface. Every chart that uses them
// also has a legend or a table view.
import type { Vendor } from "@agentbox/contracts";
import { blend, cssVariables, derived, palette } from "../theme/tokens";

/** The fixed vendor order. Colors follow the vendor, never its rank. */
export const VENDORS: readonly Vendor[] = ["claude", "codex", "copilot"];

export const VENDOR_LABELS: Record<Vendor, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
};

/** Returns the CSS variable that holds a vendor's series color. */
export function vendorColor(vendor: Vendor | null): string {
  return vendor === null ? "var(--ab-series-neutral)" : `var(--ab-vendor-${vendor})`;
}

/**
 * The dashboard's own variables. The surface, text, and status names alias
 * the shared theme; the series names keep the dataviz palette.
 */
export const dashboardTokens = {
  // Surfaces and text, from the shared theme.
  "--ab-page": palette.windowBg,
  "--ab-surface": palette.panelBg,
  "--ab-surface-2": derived.hoverBg,
  "--ab-text-2": blend(palette.text, palette.dimText, 0.5),
  "--ab-muted": palette.dimText,
  "--ab-grid": blend(palette.border, palette.panelBg, 0.6),
  "--ab-axis": palette.border,
  // Status, from the shared theme's box states.
  "--ab-good": palette.running,
  "--ab-warning": palette.pending,
  "--ab-serious": blend(palette.stopped, palette.pending, 0.5),
  "--ab-critical": palette.stopped,
  // Series, from the dataviz palette.
  "--ab-vendor-claude": "#3987e5",
  "--ab-vendor-codex": "#d95926",
  "--ab-vendor-copilot": "#199e70",
  "--ab-series-neutral": "#898781",
  "--ab-seq-1": "#184f95",
  "--ab-seq-2": "#256abf",
  "--ab-seq-3": "#3987e5",
  "--ab-seq-4": "#6da7ec",
} as const;

const fonts = {
  "--ab-font": `system-ui, -apple-system, "Segoe UI", Ubuntu, Cantarell, sans-serif`,
  "--ab-mono": `"DejaVu Sans Mono", "Ubuntu Mono", Menlo, Consolas, monospace`,
};

function declarations(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
}

/**
 * The token style sheet: the shared theme's variables plus the dashboard's.
 * Mount it once with `<style>{themeCss}</style>`. An app that also imports
 * `@agentbox/ui/theme.css` gets the same values twice, which is harmless.
 */
export const themeCss = `:root { color-scheme: dark; ${declarations(cssVariables())} ${declarations(fonts)} ${declarations(dashboardTokens)} }`;
