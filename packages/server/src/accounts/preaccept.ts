// Pre-accepts the questions that a fresh Claude account asks on its first
// start, so a box doesn't wait at a prompt that the app can't show:
//
// - The folder trust prompt. Claude Code records the answer as
//   `projects[PATH].hasTrustDialogAccepted` in the account's `.claude.json`,
//   where `PATH` is the working directory as the container sees it.
// - The bypass permissions warning. Claude Code 2.1.316 (the image's
//   version) reads `skipDangerousModePermissionPrompt` from the account's
//   `settings.json`. The older `bypassPermissionsModeAccepted` key in
//   `.claude.json` is only a legacy value that the CLI migrates into that
//   setting, so this module writes the setting.
// - `installMethod`, which the image's Claude Code checks. Imported files
//   from a native install lack it or name another method.
//
// Each edit changes only the keys named here, keeps every other key as it
// is, writes the file atomically with mode 0600, and writes nothing when the
// file already holds the values. A file that isn't a JSON object is left
// alone. Content is never logged.
import fs from "node:fs";
import path from "node:path";

/** The bypass permissions acceptance key in `settings.json` (Claude Code 2.1.316). */
export const BYPASS_ACCEPTED_KEY = "skipDangerousModePermissionPrompt";

/** The `installMethod` of the image's Claude Code, which installs with `npm install -g`. */
export const INSTALL_METHOD = "global";

export interface PreacceptOptions {
  /** Working directories as the container sees them, to mark as trusted. */
  trustDirs?: readonly string[];
  /** Set `installMethod` when it is missing. Default: true. */
  installMethod?: boolean;
  /** Accept the bypass permissions warning. Default: true. */
  bypassWarning?: boolean;
}

export interface PreacceptResult {
  /** The keys that changed, such as `projects[/work/app].hasTrustDialogAccepted`. */
  changed: string[];
  /** Files that weren't touched because they aren't valid JSON objects. */
  skipped: string[];
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reads `file` as a JSON object, applies `edit`, and writes it back when
 * `edit` returned true. A missing file reads as `{}`. Returns `"invalid"` for
 * a file that isn't a JSON object. A symbolic link is replaced by a regular
 * file, so the write never reaches the file the link points at.
 */
export function editJsonObject(file: string, edit: (obj: JsonObject) => boolean): boolean | "invalid" {
  let obj: JsonObject = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(parsed)) return "invalid";
    obj = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "invalid";
  }
  if (!edit(obj)) return false;
  const temp = `${file}.agentbox-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    // `rename` over a link replaces the link, not its target.
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return true;
}

/**
 * Pre-accepts the first-start questions in a Claude account folder. See the
 * file comment. Safe to call before every start.
 */
export function preacceptClaudeAccount(
  accountDir: string,
  options: PreacceptOptions = {},
): PreacceptResult {
  const result: PreacceptResult = { changed: [], skipped: [] };
  const trustDirs = [...new Set(options.trustDirs ?? [])].filter((d) => d !== "");
  const wantInstall = options.installMethod ?? true;

  if (trustDirs.length > 0 || wantInstall) {
    const file = path.join(accountDir, ".claude.json");
    const changed: string[] = [];
    const r = editJsonObject(file, (obj) => {
      if (wantInstall && (obj.installMethod === undefined || obj.installMethod === "")) {
        obj.installMethod = INSTALL_METHOD;
        changed.push("installMethod");
      }
      if (trustDirs.length > 0) {
        const projects = isObject(obj.projects) ? obj.projects : {};
        for (const dir of trustDirs) {
          const entry = isObject(projects[dir]) ? (projects[dir] as JsonObject) : {};
          if (entry.hasTrustDialogAccepted === true) continue;
          entry.hasTrustDialogAccepted = true;
          projects[dir] = entry;
          changed.push(`projects[${dir}].hasTrustDialogAccepted`);
        }
        if (changed.some((c) => c.startsWith("projects["))) obj.projects = projects;
      }
      return changed.length > 0;
    });
    if (r === "invalid") result.skipped.push(file);
    else if (r) result.changed.push(...changed);
  }

  if (options.bypassWarning ?? true) {
    const file = path.join(accountDir, "settings.json");
    const r = editJsonObject(file, (obj) => {
      if (obj[BYPASS_ACCEPTED_KEY] === true) return false;
      obj[BYPASS_ACCEPTED_KEY] = true;
      return true;
    });
    if (r === "invalid") result.skipped.push(file);
    else if (r) result.changed.push(BYPASS_ACCEPTED_KEY);
  }
  return result;
}
