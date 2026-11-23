// Finds specialty packs. A repository's specialties directory comes first,
// so a repository specialty overrides an account skill of the same name;
// then each account skills folder in order.
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SPECIALTIES_DIR,
  SpecialtyNameSchema,
  type EngineAccountDirs,
  type SpecialtyName,
  type SpecialtySource,
} from "@aio/contracts";
import { FRONT_MATTER } from "../roles/parse.js";

/** The skill file in a skill folder. */
export const SKILL_FILE = "SKILL.md";

/** Where the engine looks for specialties. */
export interface SpecialtySources {
  /** The repository root, whose `.aio/team/specialties/` directory comes first. */
  repoRoot: string;
  /** Account skills folders, in the order to search them; see `accountSkillDirs()`. */
  skillDirs: readonly string[];
}

/** One specialty's guidance, ready for an agent's prompt. */
export interface SpecialtyPack {
  name: SpecialtyName;
  source: SpecialtySource;
  /** The file the guidance came from. */
  path: string;
  /** The folder that holds the file, and any files the guidance refers to. */
  dir: string;
  /** The guidance: the file's Markdown without its front matter. */
  text: string;
}

/** A specialty file that has no guidance. */
export class SpecialtyError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`The specialty file ${path} is invalid: ${message}`);
    this.name = "SpecialtyError";
  }
}

/** One or more specialty names that no repository file or account skill defines. */
export class UnknownSpecialtyError extends Error {
  constructor(readonly specialties: readonly string[]) {
    super(
      `No specialty named ${specialties.join(", ")} exists in ${SPECIALTIES_DIR} or the account skills folders.`,
    );
    this.name = "UnknownSpecialtyError";
  }
}

/**
 * The skills folder of each vendor's account folder, Claude first, since
 * Claude accounts hold the skills. Pass the account folders that the engine
 * reads with `readAccountDirs()`.
 */
export function accountSkillDirs(dirs: EngineAccountDirs): string[] {
  return (["claude", "codex", "copilot"] as const)
    .map((vendor) => dirs[vendor])
    .filter((dir): dir is string => dir !== undefined)
    .map((dir) => join(dir, "skills"));
}

/** The text of `path`, or `undefined` when it doesn't exist. */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** The candidate files for `name`, in the order that the first one found wins. */
function candidates(name: string, sources: SpecialtySources) {
  const repoDir = join(sources.repoRoot, SPECIALTIES_DIR);
  return [
    { source: "repository" as const, dir: repoDir, path: join(repoDir, `${name}.md`) },
    {
      source: "repository" as const,
      dir: join(repoDir, name),
      path: join(repoDir, name, SKILL_FILE),
    },
    ...sources.skillDirs.map((skills) => ({
      source: "account" as const,
      dir: join(skills, name),
      path: join(skills, name, SKILL_FILE),
    })),
  ];
}

/**
 * Finds the pack for one specialty, or `undefined` when nothing defines it.
 * Looks for `NAME.md` and then `NAME/SKILL.md` in the repository's
 * specialties directory, then `NAME/SKILL.md` in each account skills folder.
 * Throws `SpecialtyError` for a file with no guidance.
 */
export async function findSpecialty(
  name: SpecialtyName,
  sources: SpecialtySources,
): Promise<SpecialtyPack | undefined> {
  if (!SpecialtyNameSchema.safeParse(name).success) return undefined;
  for (const candidate of candidates(name, sources)) {
    const raw = await readIfPresent(candidate.path);
    if (raw === undefined) continue;
    const match = FRONT_MATTER.exec(raw);
    const text = (match ? raw.slice(match[0].length) : raw).trim();
    if (text === "") throw new SpecialtyError(candidate.path, "the file has no guidance");
    return { name, ...candidate, text };
  }
  return undefined;
}

/**
 * Loads the packs for a task's specialties, in the order given. Throws
 * `UnknownSpecialtyError`, naming every unknown specialty, when any is
 * missing.
 */
export async function loadSpecialties(
  names: readonly SpecialtyName[],
  sources: SpecialtySources,
): Promise<SpecialtyPack[]> {
  const found = await Promise.all(names.map((name) => findSpecialty(name, sources)));
  const unknown = names.filter((_, index) => found[index] === undefined);
  if (unknown.length > 0) throw new UnknownSpecialtyError(unknown);
  return found.filter((pack): pack is SpecialtyPack => pack !== undefined);
}

/** The entries of `dir`, or none when it doesn't exist. */
async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Every specialty the sources define, sorted by name, with the source that
 * wins for each. The Architect can offer these when it tags tasks.
 */
export async function listSpecialties(
  sources: SpecialtySources,
): Promise<Array<{ name: SpecialtyName; source: SpecialtySource }>> {
  const found = new Map<string, SpecialtySource>();
  const add = (name: string, source: SpecialtySource) => {
    if (!found.has(name) && SpecialtyNameSchema.safeParse(name).success) found.set(name, source);
  };
  const hasSkill = (dir: string) =>
    access(join(dir, SKILL_FILE)).then(
      () => true,
      () => false,
    );
  const repoDir = join(sources.repoRoot, SPECIALTIES_DIR);
  for (const entry of await entries(repoDir)) {
    if (entry.isFile() && entry.name.endsWith(".md")) add(entry.name.slice(0, -3), "repository");
    else if (!entry.isFile() && (await hasSkill(join(repoDir, entry.name)))) {
      add(entry.name, "repository");
    }
  }
  for (const skills of sources.skillDirs) {
    for (const entry of await entries(skills)) {
      if (!entry.isFile() && (await hasSkill(join(skills, entry.name)))) add(entry.name, "account");
    }
  }
  return [...found]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, source]) => ({ name, source }));
}
