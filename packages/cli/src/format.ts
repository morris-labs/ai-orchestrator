// Plain-text output: aligned tables and key-value blocks.
//
// Text from the server can hold model output, such as a finding's title, so
// everything the CLI prints goes through `terminalText` or `jsonText` first.
// A raw escape sequence there could write to the clipboard (OSC 52), retitle
// the terminal, or hide other output.

/** C0 controls but tab and newline, DEL, and C1 controls. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** Every C0 control, DEL, and C1 control. */
// eslint-disable-next-line no-control-regex -- as above.
const ALL_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

const visible = (c: string) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;

/** Text with every control character but tab and newline shown as `\xNN`. */
export function terminalText(text: string): string {
  return text.replace(CONTROLS, visible);
}

/**
 * JSON for a terminal. `JSON.stringify` escapes C0 controls but leaves DEL
 * and C1 controls raw; this escapes those as `\u00NN`, which stays valid JSON.
 */
export function jsonText(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Renders rows under headers, columns padded to their widest cell. */
export function table(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cells = rows.map((r) => headers.map((_, i) => cell(r[i])));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)),
  );
  const line = (r: string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(headers), ...cells.map(line)].join("\n") + "\n";
}

/** Renders `key: value` lines with the keys aligned. */
export function keyValues(pairs: [string, string | number | boolean | null | undefined][]): string {
  const width = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${`${k}:`.padEnd(width + 1)} ${cell(v)}`).join("\n") + "\n";
}

/** A table or key-value cell: one line, with every control character shown. */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value).replace(ALL_CONTROLS, visible);
}

/** Formats a fraction as a whole percentage. */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
