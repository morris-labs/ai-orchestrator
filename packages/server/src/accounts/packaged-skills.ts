// Installs the skills that the server package ships, such as `aio-build`,
// into Claude account folders. The package owns each skill folder it ships:
// an install writes the packaged files into `ACCOUNT/skills/NAME/` and
// replaces any copy that differs. Nothing else in the account changes, and a
// symbolic link anywhere on the way stops the install for that account, so
// it can't write outside the account folder (ADR 0002).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The packaged skills: `assets/skills/` in the server package, beside
 * `dist/` and `src/`, so the path holds for the built server and for tests.
 */
export const PACKAGED_SKILLS_DIR = fileURLToPath(new URL("../../assets/skills", import.meta.url));

export interface SkillInstallReport {
  /** Account folders that got a new or changed file, as `DIR (SKILL)`. */
  changed: string[];
  /** Why an account folder didn't get a skill. */
  skipped: string[];
}

/** Every regular file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

/** Throws when `target` exists as anything but a real directory. */
function ensureRealDir(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    fs.mkdirSync(target, { mode: 0o700 });
    return;
  }
  if (stat.isSymbolicLink()) throw new Error(`${target} is a symbolic link`);
  if (!stat.isDirectory()) throw new Error(`${target} isn't a directory`);
}

/** Writes `text` to `file` unless it already holds it. Returns whether it wrote. */
function writeIfChanged(file: string, text: Buffer): boolean {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (stat?.isSymbolicLink()) throw new Error(`${file} is a symbolic link`);
  if (stat?.isFile() && fs.readFileSync(file).equals(text)) return false;
  const temp = `${file}.aio-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return true;
}

/** Installs one skill folder into one account. Returns whether a file changed. */
function installSkill(accountDir: string, name: string, source: string): boolean {
  ensureRealDir(path.join(accountDir, "skills"));
  const root = path.join(accountDir, "skills", name);
  ensureRealDir(root);
  let changed = false;
  for (const rel of filesUnder(source)) {
    let dir = root;
    for (const part of path
      .dirname(rel)
      .split(path.sep)
      .filter((p) => p && p !== ".")) {
      dir = path.join(dir, part);
      ensureRealDir(dir);
    }
    if (writeIfChanged(path.join(root, rel), fs.readFileSync(path.join(source, rel))))
      changed = true;
  }
  return changed;
}

/**
 * Installs every skill folder in `source` into each account folder that
 * exists. A missing account folder is skipped silently; its account gets the
 * skills when it is created. A failure in one account never stops the others.
 */
export function installPackagedSkills(
  accountDirs: readonly string[],
  source: string = PACKAGED_SKILLS_DIR,
): SkillInstallReport {
  const report: SkillInstallReport = { changed: [], skipped: [] };
  const skills = fs
    .readdirSync(source, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const accountDir of accountDirs) {
    try {
      if (!fs.lstatSync(accountDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of skills) {
      try {
        if (installSkill(accountDir, name, path.join(source, name)))
          report.changed.push(`${accountDir} (${name})`);
      } catch (err) {
        report.skipped.push(
          `Skipped the ${name} skill for ${accountDir}: ${(err as Error).message}.`,
        );
      }
    }
  }
  return report;
}
