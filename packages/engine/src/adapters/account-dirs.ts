// The account folder each vendor call uses. The server writes the default
// folder of each vendor to `account-dirs.json` in a folder that the container
// mounts read-only (`ENGINE_CONFIG_MOUNT`), and rewrites it when the defaults
// change; the engine reads it for every call, so a change needs no restart.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENGINE_ACCOUNT_DIRS_FILE,
  EngineAccountDirsSchema,
  type EngineAccountDirs,
  type Vendor,
} from "@aio/contracts";

/** Returns the account folder for one call, or `undefined` when none is known. */
export type AccountDirSource = () => string | undefined;

/** Receives a problem with the account folders file. */
export type AccountDirWarn = (message: string) => void;

/**
 * The folders in an account folders file. Each vendor's entry stands alone, so
 * a bad entry costs only that vendor its folder. A vendor with no folder uses
 * its home folder, as in `host` mode. Every problem goes to `warn`, since a
 * fallback can bill or sign in as another account.
 */
export function readAccountDirs(file: string, warn?: AccountDirWarn): EngineAccountDirs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    warn?.(
      `Couldn't read the account folders in ${file}, so vendor CLIs use their home folders: ${(error as Error).message}`,
    );
    return {};
  }
  const entries = parsed !== null && typeof parsed === "object" ? parsed : {};
  const out: EngineAccountDirs = {};
  for (const vendor of ["claude", "codex", "copilot"] as const) {
    const value = (entries as Record<string, unknown>)[vendor];
    if (value === undefined) continue;
    const entry = EngineAccountDirsSchema.safeParse({ [vendor]: value });
    if (entry.success) Object.assign(out, entry.data);
    else warn?.(`The ${vendor} entry in ${file} isn't valid, so ${vendor} uses its home folder.`);
  }
  return out;
}

/** The account folders file in a folder such as `ENGINE_CONFIG_MOUNT`. */
export function accountDirsFileIn(stateDir: string): string {
  return join(stateDir, ENGINE_ACCOUNT_DIRS_FILE);
}

/** A source per vendor that reads `file` on every call. Repeats of one problem warn once. */
export function accountDirSources(
  file: string,
  warn?: AccountDirWarn,
): Record<Vendor, AccountDirSource> {
  const seen = new Set<string>();
  const once: AccountDirWarn = (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    warn?.(message);
  };
  return {
    claude: () => readAccountDirs(file, once).claude,
    codex: () => readAccountDirs(file, once).codex,
    copilot: () => readAccountDirs(file, once).copilot,
  };
}
