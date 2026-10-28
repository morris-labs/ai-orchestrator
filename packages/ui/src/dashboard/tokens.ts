// Minimal theme tokens for the dashboard. Dark is the default; light applies
// when the system asks for it or a parent sets `data-theme="light"`. At merge
// these give way to the shared theme in `packages/ui`, so keep the token
// names generic and every color here.
//
// The vendor colors are the first three slots of the dataviz reference
// palette, which pass the all-pairs colorblind checks in both modes. Every
// chart that uses them also has a legend or a table view, because the light
// aqua sits below 3:1 against the light surface.
import type { Vendor } from "@agentbox/contracts";

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

const dark = `
  color-scheme: dark;
  --ab-page: #0d0d0d;
  --ab-surface: #1a1a19;
  --ab-surface-2: #232321;
  --ab-text: #f0efec;
  --ab-text-2: #c3c2b7;
  --ab-muted: #898781;
  --ab-grid: #2c2c2a;
  --ab-axis: #383835;
  --ab-border: rgba(255, 255, 255, 0.1);
  --ab-accent: #3987e5;
  --ab-vendor-claude: #3987e5;
  --ab-vendor-codex: #d95926;
  --ab-vendor-copilot: #199e70;
  --ab-series-neutral: #898781;
  --ab-seq-1: #184f95;
  --ab-seq-2: #256abf;
  --ab-seq-3: #3987e5;
  --ab-seq-4: #6da7ec;
`;

const light = `
  color-scheme: light;
  --ab-page: #f9f9f7;
  --ab-surface: #fcfcfb;
  --ab-surface-2: #f0efec;
  --ab-text: #0b0b0b;
  --ab-text-2: #52514e;
  --ab-muted: #898781;
  --ab-grid: #e1e0d9;
  --ab-axis: #c3c2b7;
  --ab-border: rgba(11, 11, 11, 0.1);
  --ab-accent: #2a78d6;
  --ab-vendor-claude: #2a78d6;
  --ab-vendor-codex: #eb6834;
  --ab-vendor-copilot: #1baf7a;
  --ab-series-neutral: #898781;
  --ab-seq-1: #86b6ef;
  --ab-seq-2: #5598e7;
  --ab-seq-3: #2a78d6;
  --ab-seq-4: #1c5cab;
`;

/** Status colors are fixed in both modes and always ship with an icon and a label. */
const status = `
  --ab-good: #0ca30c;
  --ab-warning: #fab219;
  --ab-serious: #ec835a;
  --ab-critical: #d03b3b;
  --ab-font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --ab-mono: ui-monospace, "SFMono-Regular", Menlo, monospace;
`;

/** The token style sheet. Mount it once with `<style>{themeCss}</style>`. */
export const themeCss = `
:root { ${dark} ${status} }
@media (prefers-color-scheme: light) {
  :root:where(:not([data-theme="dark"])) { ${light} }
}
:root[data-theme="light"] { ${light} }
:root[data-theme="dark"] { ${dark} }
`;
