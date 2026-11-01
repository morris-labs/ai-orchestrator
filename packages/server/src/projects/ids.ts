// Project identity (inventory section 3.2): the normalized root, the id
// derived from it, and the primary repository default.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ContainerPathError, normalizeWindowsPath, type HostOs } from "@aio/contracts";

/**
 * Normalizes a project root the way 3.3.5 did (`QDir::cleanPath` of the
 * trimmed string): collapses `//`, resolves `.` and `..`, and drops a trailing
 * slash. Returns `""` for a blank input.
 *
 * On Windows the root gets the stored form, `C:/Users/dev/project`: an
 * uppercase drive letter and forward slashes, so `c:\Users\dev\project\`
 * names the same project. The rest of the path keeps its case, so two
 * spellings that differ in case are two projects. A path that has no
 * Windows form, such as a UNC path, is returned trimmed, for the caller's
 * `hostPathProblem()` check to refuse.
 */
export function normalizeRoot(dir: string, hostOs: HostOs = "linux"): string {
  const trimmed = dir.trim();
  if (trimmed === "") return "";
  if (hostOs === "win32") {
    try {
      return normalizeWindowsPath(trimmed);
    } catch (err) {
      if (err instanceof ContainerPathError) return trimmed;
      throw err;
    }
  }
  const cleaned = path.posix.normalize(trimmed);
  return cleaned.length > 1 && cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
}

/**
 * Collapses every run of characters other than ASCII letters and digits into
 * one `-`, drops leading and trailing dashes, and keeps case.
 */
export function projectSlug(s: string): string {
  let out = "";
  let lastDash = true;
  for (const ch of s) {
    if (/^[0-9A-Za-z]$/.test(ch)) {
      out += ch;
      lastDash = false;
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  return out.replace(/-+$/, "");
}

/** `slug(basename(root))-<first 8 hex digits of sha1(root)>`, or `""` for a blank root. */
export function projectIdForRoot(root: string): string {
  const norm = normalizeRoot(root);
  if (norm === "") return "";
  const hash = crypto.createHash("sha1").update(norm, "utf8").digest("hex").slice(0, 8);
  const readable = projectSlug(path.posix.basename(norm));
  return `${readable || "project"}-${hash}`;
}

/** The root itself when it holds a `.git` (directory or file), else `undefined`. */
export function detectPrimaryRepo(root: string): string | undefined {
  return fs.existsSync(path.join(root, ".git")) ? root : undefined;
}

/** A project's display name when none is set: the folder name, else the root. */
export function defaultProjectName(root: string): string {
  return path.posix.basename(root) || root;
}
