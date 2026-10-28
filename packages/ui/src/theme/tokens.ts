// The dark palette, ported from the Qt app's `Theme.cpp`. The terminal panes
// are dark whatever the desktop theme says, so the whole app uses one fixed
// dark palette rather than following the system.

/** Base colors, as in `Theme.cpp`. */
export const palette = {
  windowBg: "#1b1c1e",
  panelBg: "#232427",
  baseBg: "#151618",
  border: "#33353a",
  text: "#e6e6e6",
  dimText: "#9297a0",
  accent: "#d97757",
  running: "#5fb37a",
  stopped: "#d96c6c",
  known: "#8a8f98",
  pending: "#d9b057",
  terminalBg: "#101113",
  terminalFg: "#e6e6e6",
  updateBarBg: "#3a3020",
  updateBarBorder: "#7a6030",
} as const;

export type PaletteKey = keyof typeof palette;

function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Mixes `a` into `b`: `amount` 1 gives `a`, 0 gives `b`. Matches `blend()` in `Theme.cpp`. */
export function blend(a: string, b: string, amount: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex(ca.map((c, i) => Math.trunc(c * amount + (cb[i] ?? 0) * (1 - amount))));
}

/** Scales every channel by `factor`, an approximation of `QColor::lighter()` and `darker()`. */
export function scale(hex: string, factor: number): string {
  return toHex(parseHex(hex).map((c) => c * factor));
}

/** Derived colors that the Qt stylesheet computed from the base palette. */
export const derived = {
  altRowBg: scale(palette.baseBg, 1.12),
  hoverBg: scale(palette.panelBg, 1.28),
  disabledText: scale(palette.dimText, 1 / 1.5),
  selectionBg: blend(palette.accent, palette.baseBg, 0.22),
} as const;

/**
 * The CPU and memory bar color for a fraction from 0 to 1: green up to 0.6,
 * then a linear blend to red at 1. Matches `Theme::barChunkColor()`.
 */
export function barChunkColor(fraction: number): string {
  const green = [45, 160, 80];
  const red = [200, 80, 50];
  if (fraction <= 0.6) return toHex(green);
  const t = Math.min(1, (fraction - 0.6) / 0.4);
  return toHex(green.map((g, i) => Math.trunc(g + ((red[i] ?? 0) - g) * t)));
}

/** The xterm.js color theme for terminal panes. */
export const terminalTheme = {
  background: palette.terminalBg,
  foreground: palette.terminalFg,
  cursor: palette.terminalFg,
  cursorAccent: palette.terminalBg,
  selectionBackground: blend(palette.accent, palette.terminalBg, 0.4),
} as const;

/** Every token as a CSS custom property, `--ab-<name>`. */
export function cssVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...palette, ...derived })) {
    out[`--ab-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`] = v;
  }
  return out;
}
