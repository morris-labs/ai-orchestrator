// Reads the 3.3.5 `key=value` record files (`known/`, `projects/`,
// `ssh_remotes/`, `global`).
import fs from "node:fs";

/**
 * Parses `key=value` lines in order. Each line splits at its first `=`; a
 * line without one is skipped, as the Qt app did. Keys may repeat. A
 * leading byte order mark is dropped.
 */
export function parseKv(text: string): [string, string][] {
  const out: [string, string][] = [];
  // Qt's QTextStream skipped a UTF-8 byte order mark; without that, an
  // editor's BOM would end up in the first key.
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out.push([line.slice(0, eq), line.slice(eq + 1)]);
  }
  return out;
}

/** Reads and parses a record file. */
export function readKvFile(file: string): [string, string][] {
  return parseKv(fs.readFileSync(file, "utf8"));
}

/** The last value of `key`, or `undefined`. */
export function kvLast(entries: readonly [string, string][], key: string): string | undefined {
  let value: string | undefined;
  for (const [k, v] of entries) if (k === key) value = v;
  return value;
}

/** Every value of a repeatable `key`, in file order. */
export function kvAll(entries: readonly [string, string][], key: string): string[] {
  return entries.filter(([k]) => k === key).map(([, v]) => v);
}
