// A reader for the INI files Qt's QSettings writes on Linux
// (`~/.config/claude-box/claude-box.conf`).
import fs from "node:fs";

/**
 * A QSettings value: a string, a string list (written with unquoted commas
 * or as `@Invalid()` for an empty list), or `null` for any other `@Variant`.
 */
export type QtValue = string | string[] | null;

/** Decodes a percent-encoded key or group name (`%XX` UTF-8 bytes and `%UXXXX`). */
export function decodeIniKey(raw: string): string {
  let out = "";
  const bytes: number[] = [];
  const flush = () => {
    if (bytes.length) out += Buffer.from(bytes).toString("utf8");
    bytes.length = 0;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    if (ch === "%" && raw[i + 1] === "U" && /^[0-9A-Fa-f]{4}$/.test(raw.slice(i + 2, i + 6))) {
      flush();
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
      i += 5;
    } else if (ch === "%" && /^[0-9A-Fa-f]{2}$/.test(raw.slice(i + 1, i + 3))) {
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      flush();
      out += ch === "\\" ? "/" : ch;
    }
  }
  flush();
  return out;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
  "'": "'",
  "?": "?",
};

/**
 * Splits a raw INI value into its unescaped parts. Returns the parts and
 * whether an unquoted comma made it a list.
 */
export function unescapeIniValue(raw: string): { parts: string[]; isList: boolean } {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let isList = false;
  // Unquoted whitespace is kept only between other characters.
  let pendingSpace = "";
  let started = false;
  const push = (s: string, quoted: boolean) => {
    if (!quoted && /\s/.test(s)) {
      if (started) pendingSpace += s;
      return;
    }
    current += pendingSpace + s;
    pendingSpace = "";
    started = true;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break;
      if (next in SIMPLE_ESCAPES) {
        push(SIMPLE_ESCAPES[next] as string, true);
        i += 1;
      } else if (next === "x") {
        let j = i + 2;
        let hex = "";
        while (j < raw.length && hex.length < 4 && /[0-9A-Fa-f]/.test(raw[j] as string)) {
          hex += raw[j];
          j += 1;
        }
        if (hex) push(String.fromCharCode(parseInt(hex, 16)), true);
        i = j - 1;
      } else if (/[0-7]/.test(next)) {
        let j = i + 1;
        let oct = "";
        while (j < raw.length && oct.length < 3 && /[0-7]/.test(raw[j] as string)) {
          oct += raw[j];
          j += 1;
        }
        push(String.fromCharCode(parseInt(oct, 8)), true);
        i = j - 1;
      } else {
        push(next, true);
        i += 1;
      }
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
      pendingSpace = "";
      started = false;
      isList = true;
    } else {
      push(ch, inQuotes);
    }
  }
  parts.push(current);
  return { parts, isList };
}

/** Converts one raw value to a `QtValue`, following QSettings' `@` rules. */
export function parseIniValue(raw: string): QtValue {
  const { parts, isList } = unescapeIniValue(raw);
  if (isList) return parts.map(unAt);
  const only = parts[0] ?? "";
  if (only === "@Invalid()") return [];
  if (only.startsWith("@ByteArray(") && only.endsWith(")")) return only.slice(11, -1);
  if (only.startsWith("@Variant(")) return null;
  return unAt(only);
}

function unAt(s: string): string {
  return s.startsWith("@@") ? s.slice(1) : s;
}

/**
 * Parses a QSettings INI file into `group/key` to value. Keys in the
 * `[General]` section have no group prefix; nested keys use `/`.
 */
export function parseQtIni(text: string): Map<string, QtValue> {
  const out = new Map<string, QtValue>();
  let group = "";
  // A backslash at the end of a line continues the value on the next line.
  const lines: string[] = [];
  let carry = "";
  for (const raw of text.split(/\r?\n/)) {
    if (raw.endsWith("\\") && !raw.endsWith("\\\\")) {
      carry += raw.slice(0, -1);
      continue;
    }
    lines.push(carry + raw);
    carry = "";
  }
  if (carry) lines.push(carry);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const name = trimmed.slice(1, -1);
      group = name === "General" ? "" : decodeIniKey(name.replace(/^%General$/, "General"));
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = decodeIniKey(line.slice(0, eq).trim());
    const value = parseIniValue(line.slice(eq + 1));
    out.set(group ? `${group}/${key}` : key, value);
  }
  return out;
}

/** Reads a QSettings INI file; a missing file gives an empty map. */
export function readQtIni(file: string): Map<string, QtValue> {
  if (!fs.existsSync(file)) return new Map();
  return parseQtIni(fs.readFileSync(file, "utf8"));
}

/** A value as a string; a list joins with `, ` as `QVariant::toString` would not, so it gives `undefined`. */
export function qtString(value: QtValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A value as a string list; a single string is a one-item list. */
export function qtList(value: QtValue | undefined): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? [value] : value;
}

/** A value as a boolean, as `QVariant::toBool` reads `true`, `1`, and the rest. */
export function qtBool(value: QtValue | undefined): boolean | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return !(v === "" || v === "0" || v === "false");
}
