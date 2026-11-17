// Explicit migration of legacy links. Account creation never shares host config.
import fs from "node:fs";
import path from "node:path";

export interface UserConfigResult {
  entries: Record<string, "copied" | "local">;
  errors: Record<string, string>;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Replace legacy host links with independent copies, leaving real files alone.
 * `externalTo` also copies other outside links during an explicit account import.
 * The transcript-store projects link is always preserved.
 */
export function copyLinkedConfig(
  accountDir: string,
  hostDirs: readonly string[],
  externalTo?: string,
): UserConfigResult {
  const result: UserConfigResult = { entries: {}, errors: {} };
  const roots = hostDirs.flatMap((dir) => {
    try {
      return [path.resolve(dir), fs.realpathSync(dir)];
    } catch {
      return [path.resolve(dir)];
    }
  });
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      const relative = path.relative(accountDir, entry);
      if (relative === "projects") continue;
      const stat = fs.lstatSync(entry);
      if (!stat.isSymbolicLink()) {
        result.entries[relative] = "local";
        if (stat.isDirectory()) walk(entry);
        continue;
      }
      const link = fs.readlinkSync(entry);
      const target = path.resolve(path.dirname(entry), link);
      let resolved = target;
      try {
        resolved = fs.realpathSync(entry);
      } catch {
        /* Report dangling host links below. */
      }
      if (
        !roots.some((root) => inside(root, target) || inside(root, resolved)) &&
        !(externalTo && !inside(externalTo, resolved))
      )
        continue;
      const temp = `${entry}.copy-${process.pid}-${Date.now()}`;
      try {
        fs.cpSync(resolved, temp, { recursive: true, dereference: true, preserveTimestamps: true });
        fs.unlinkSync(entry);
        try {
          fs.renameSync(temp, entry);
        } catch (err) {
          fs.symlinkSync(link, entry);
          throw err;
        }
        result.entries[relative] = "copied";
      } catch (err) {
        result.errors[relative] = (err as Error).message;
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }
  };
  walk(accountDir);
  return result;
}
