// The account folder each vendor call uses. The server writes the default
// folder of each vendor to `account-dirs.json` in the container's state
// directory, and rewrites it when the defaults change; the engine reads it
// for every call, so a change needs no restart.
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

/**
 * The folders in an account folders file, or an empty object when the file
 * is missing, unreadable, or not valid. An empty object leaves every CLI on
 * its home folder, as in `host` mode.
 */
export function readAccountDirs(file: string): EngineAccountDirs {
  try {
    const parsed = EngineAccountDirsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The account folders file in a state directory. */
export function accountDirsFileIn(stateDir: string): string {
  return join(stateDir, ENGINE_ACCOUNT_DIRS_FILE);
}

/** A source per vendor that reads `file` on every call. */
export function accountDirSources(file: string): Record<Vendor, AccountDirSource> {
  return {
    claude: () => readAccountDirs(file).claude,
    codex: () => readAccountDirs(file).codex,
    copilot: () => readAccountDirs(file).copilot,
  };
}
