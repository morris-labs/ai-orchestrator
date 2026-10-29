// Temporary directories for tests. `setup-tmp.ts` removes every directory
// that `tempDir()` made once the test file that made it finishes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const made = new Set<string>();

/** Makes a directory under the system temporary directory and registers it for removal. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
}

/** Removes every directory `tempDir()` made so far. */
export function removeTempDirs(): void {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  made.clear();
}
