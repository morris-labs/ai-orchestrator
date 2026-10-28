// Plain-text output: aligned tables and key-value blocks.

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

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

/** Formats a fraction as a whole percentage. */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
