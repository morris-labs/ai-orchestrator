// Keeps Claude Code from deleting transcripts.
//
// Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30)
// from the `projects` folder of its config directory. Every Claude account
// links `projects` to the shared transcript store, so an account whose
// `settings.json` lacks a long enough `cleanupPeriodDays` deletes the store's
// old transcripts for every account and for the host. This happened once:
// see docs/accounts.md, "Transcript retention".
//
// `ensureRetention()` runs before every Claude session start on an account
// and when an account is created, imported, or seeded. It raises
// `cleanupPeriodDays` to the protected value and never lowers a larger one.
// It throws when it can't make sure, so the caller can fail the start.
//
// Claude Code 2.1.316 has one other key with "cleanup" in its name:
// `desktopSessionCleanupPeriodDays`. It bounds the transcripts of the desktop
// app and Cowork, which the sweep exempts, and its default of 0 means no
// ceiling. It can't delete a box's transcripts, so Agent Box doesn't write
// it; `accounts check` warns when it is set to more than 0.
import fs from "node:fs";
import path from "node:path";
import { editJsonObject } from "./preaccept.js";

/** The key in `settings.json` that sets the transcript retention. */
export const RETENTION_KEY = "cleanupPeriodDays";

/** The key that gives desktop-surface transcripts a deletion ceiling. */
export const DESKTOP_CEILING_KEY = "desktopSessionCleanupPeriodDays";

/** Days of retention when neither the host nor the settings name a value (about 10 years). */
export const DEFAULT_RETENTION_DAYS = 3650;

/** A failure to make sure of the retention. The message is for a person. */
export class RetentionError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = "RetentionError";
  }
}

function validDays(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/** The host's `cleanupPeriodDays` from `~/.claude/settings.json`, or `undefined`. */
export function hostRetentionDays(home: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const v = (parsed as Record<string, unknown>)[RETENTION_KEY];
    return validDays(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The protected retention: the host's value when it sets one, else the
 * `transcriptRetentionDays` setting, else 3650.
 */
export function protectedRetentionDays(home: string, setting: number | undefined): number {
  return hostRetentionDays(home) ?? setting ?? DEFAULT_RETENTION_DAYS;
}

/**
 * Makes sure that `accountDir/settings.json` sets `cleanupPeriodDays` to at
 * least `days`. Returns whether it wrote the file. Throws `RetentionError`
 * when the file isn't a JSON object or can't be written.
 */
export function ensureRetention(accountDir: string, days: number): boolean {
  const file = path.join(accountDir, "settings.json");
  let changed: boolean | "invalid";
  try {
    changed = editJsonObject(file, (obj) => {
      const have = obj[RETENTION_KEY];
      if (validDays(have) && have >= days) return false;
      obj[RETENTION_KEY] = days;
      return true;
    });
  } catch (err) {
    throw new RetentionError(
      `Can't write ${RETENTION_KEY} to ${file}: ${(err as Error).message}. Without it, Claude Code deletes transcripts older than 30 days. Fix the file's permissions and start again.`,
      file,
    );
  }
  if (changed === "invalid") {
    throw new RetentionError(
      `${file} isn't a JSON object, so ${RETENTION_KEY} can't be set. Without it, Claude Code deletes transcripts older than 30 days. Fix or remove the file and start again.`,
      file,
    );
  }
  return changed;
}

/**
 * The warnings that `accounts check` shows for an account's retention:
 * a missing or lower `cleanupPeriodDays`, and a desktop ceiling above 0.
 */
export function retentionWarnings(accountDir: string, days: number): string[] {
  const file = path.join(accountDir, "settings.json");
  let obj: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return [
        `${file} isn't a JSON object, so ${RETENTION_KEY} can't be checked. Boxes on this account won't start until it is fixed.`,
      ];
    }
    obj = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return [`${file} can't be read as JSON, so ${RETENTION_KEY} can't be checked.`];
    }
  }
  const out: string[] = [];
  const have = obj[RETENTION_KEY];
  if (have === undefined) {
    out.push(
      `${file} doesn't set ${RETENTION_KEY}, so Claude Code deletes transcripts older than 30 days from the shared store. The next box start sets it to ${days}.`,
    );
  } else if (!validDays(have) || have < days) {
    out.push(
      `${file} sets ${RETENTION_KEY} to ${JSON.stringify(have)}, below ${days}, so Claude Code deletes older transcripts from the shared store. The next box start raises it.`,
    );
  }
  const ceiling = obj[DESKTOP_CEILING_KEY];
  if (typeof ceiling === "number" && ceiling > 0) {
    out.push(
      `${file} sets ${DESKTOP_CEILING_KEY} to ${ceiling}, so Claude Code deletes desktop-app transcripts older than that.`,
    );
  }
  return out;
}
