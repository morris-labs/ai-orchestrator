// A small leveled logger that writes one JSON line per record to stderr.
import type { LogLevel, Logger } from "../api/core-interface.js";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const LOG_LEVELS = Object.keys(ORDER) as LogLevel[];

/** Returns true when `value` names a log level. */
export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(ORDER, value);
}

/** Field names whose values the logger never writes. */
const SECRET_KEYS = /token|secret|password|authorization/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEYS.test(key) ? "[redacted]" : value;
  }
  return out;
}

/**
 * Creates a logger that drops records below `level` and writes the rest to
 * `write` (stderr by default). Fields whose names look like secrets are
 * replaced with `[redacted]`.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(line),
  now: () => Date = () => new Date(),
): Logger {
  const emit = (recordLevel: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[recordLevel] < ORDER[level]) return;
    const record = { time: now().toISOString(), level: recordLevel, msg: message };
    write(`${JSON.stringify(fields ? { ...record, ...redact(fields) } : record)}\n`);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/** A logger that discards everything, for tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
