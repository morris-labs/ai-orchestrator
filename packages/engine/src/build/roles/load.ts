// Loads build roles: the role library that ships with the engine, then the
// repository's `.aio/team/` directory, whose roles replace library roles of
// the same name or add new ones.
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM_DIR, type RoleDefinition, type RoleSource } from "@aio/contracts";
import { RoleError, parseRole } from "./parse.js";

/**
 * The shipped role library. The build copies the `library` directory next to
 * the compiled module, so this path holds in `src/` and in `dist/`.
 */
export const ROLE_LIBRARY_DIR = fileURLToPath(new URL("./library/", import.meta.url));

export interface LoadRolesOptions {
  /** The role library directory. Tests pass their own; the default is `ROLE_LIBRARY_DIR`. */
  libraryDir?: string;
}

/** The role files directly in `dir`, sorted, or none when `dir` doesn't exist. */
async function roleFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

async function readRoles(dir: string, source: RoleSource): Promise<RoleDefinition[]> {
  const files = await roleFiles(dir);
  return Promise.all(
    files.map(async (path) => {
      const role = parseRole(await readFile(path, "utf8"), path, source);
      const stem = basename(path, ".md");
      if (role.name !== stem) {
        throw new RoleError(path, `name: ${role.name} must match the file name ${stem}.md`);
      }
      return role;
    }),
  );
}

/**
 * Loads every role for the repository at `repoRoot`: the shipped library,
 * with each role in the repository's team directory replacing the library
 * role of the same name. Throws `RoleError` on any invalid role file.
 */
export async function loadRoles(
  repoRoot: string,
  options: LoadRolesOptions = {},
): Promise<Map<string, RoleDefinition>> {
  const [library, repository] = await Promise.all([
    readRoles(options.libraryDir ?? ROLE_LIBRARY_DIR, "library"),
    readRoles(join(repoRoot, TEAM_DIR), "repository"),
  ]);
  const roles = new Map<string, RoleDefinition>();
  for (const role of [...library, ...repository]) roles.set(role.name, role);
  return roles;
}

/** A role name that neither the library nor the repository defines. */
export class UnknownRoleError extends Error {
  constructor(
    readonly role: string,
    known: string,
  ) {
    super(`No role named ${role} exists. Known roles: ${known}.`);
    this.name = "UnknownRoleError";
  }
}

/**
 * Loads one role for the repository at `repoRoot`. Throws `UnknownRoleError`
 * when it doesn't exist and `RoleError` on any invalid role file.
 */
export async function loadRole(
  name: string,
  repoRoot: string,
  options: LoadRolesOptions = {},
): Promise<RoleDefinition> {
  const roles = await loadRoles(repoRoot, options);
  const role = roles.get(name);
  if (!role) {
    const known = [...roles.keys()].sort().join(", ") || "none";
    throw new UnknownRoleError(name, known);
  }
  return role;
}
