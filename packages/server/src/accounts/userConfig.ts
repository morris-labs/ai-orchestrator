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
  mirror?: string,
): UserConfigResult {
  const result: UserConfigResult = { entries: {}, errors: {} };
  for (const entry of repairMirroredLinks(accountDir, mirror)) result.entries[entry] = "local";
  const roots = hostRoots(hostDirs);
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
        copyEntry(resolved, temp, resolved, roots, new Set());
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

function hostRoots(hostDirs: readonly string[]): string[] {
  return hostDirs.flatMap((dir) => {
    try {
      return [path.resolve(dir), fs.realpathSync(dir)];
    } catch {
      return [path.resolve(dir)];
    }
  });
}

/**
 * Copies `src` to `dest`. A link that stays inside `top` stays a relative
 * link, so the copy keeps its own internal links. A link into `roots` is
 * copied as the content it leads to. Any other link is copied as a link.
 */
function copyEntry(
  src: string,
  dest: string,
  top: string,
  roots: readonly string[],
  active: Set<string>,
): void {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(src);
    const target = path.resolve(path.dirname(src), link);
    if (inside(top, target)) {
      fs.symlinkSync(path.relative(path.dirname(src), target), dest);
      return;
    }
    let real: string;
    try {
      real = fs.realpathSync(src);
    } catch {
      if (roots.some((root) => inside(root, target))) {
        throw new Error(`${src} leads to ${target}, which doesn't exist`);
      }
      fs.symlinkSync(link, dest);
      return;
    }
    if (roots.some((root) => inside(root, target) || inside(root, real))) {
      copyEntry(real, dest, top, roots, active);
    } else {
      fs.symlinkSync(link, dest);
    }
    return;
  }
  if (stat.isDirectory()) {
    const real = fs.realpathSync(src);
    if (active.has(real)) throw new Error(`${src} leads back into a folder that contains it`);
    active.add(real);
    fs.mkdirSync(dest, { mode: stat.mode & 0o7777 });
    for (const name of fs.readdirSync(src)) {
      copyEntry(path.join(src, name), path.join(dest, name), top, roots, active);
    }
    active.delete(real);
    fs.utimesSync(dest, stat.atime, stat.mtime);
    return;
  }
  // Sockets, pipes, and devices are runtime state, not configuration.
  if (!stat.isFile()) return;
  fs.copyFileSync(src, dest);
  fs.utimesSync(dest, stat.atime, stat.mtime);
}

/**
 * Points each link at `mirror/X` to the account's own `X` instead, as a
 * relative link, when the account has its own `X`. Earlier versions of
 * relink left such links when they copied a linked folder, and a tool in a
 * box, where the vendor folder path leads to the account, can create them
 * too. Returns the entries it repaired, relative to `accountDir`.
 */
export function repairMirroredLinks(accountDir: string, mirror?: string): string[] {
  if (!mirror) return [];
  const root = path.resolve(mirror);
  const repaired: string[] = [];
  const visit = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      const relative = path.relative(accountDir, entry);
      if (relative === "projects") continue;
      const stat = fs.lstatSync(entry);
      if (stat.isDirectory()) {
        visit(entry);
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      const target = path.resolve(dir, fs.readlinkSync(entry));
      if (!inside(root, target)) continue;
      const own = path.join(accountDir, path.relative(root, target));
      const ownRelative = path.relative(accountDir, own);
      if (
        own === entry ||
        inside(entry, own) ||
        ownRelative === "projects" ||
        ownRelative.startsWith(`projects${path.sep}`) ||
        !fs.existsSync(own)
      ) {
        continue;
      }
      fs.unlinkSync(entry);
      fs.symlinkSync(path.relative(dir, own), entry);
      repaired.push(relative);
    }
  };
  visit(accountDir);
  return repaired;
}

/** Identify legacy host links from metadata only; never read their contents. */
export function hostConfigLinks(accountDir: string, hostPaths: readonly string[]): string[] {
  const linked: string[] = [];
  const visit = (entry: string): void => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) {
      const target = path.resolve(path.dirname(entry), fs.readlinkSync(entry));
      let real = target;
      try {
        real = fs.realpathSync(entry);
      } catch {
        /* Dangling legacy links still need migration. */
      }
      if (hostPaths.some((root) => inside(root, target) || inside(root, real))) linked.push(entry);
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) {
        if (entry === accountDir && name === "projects") continue;
        visit(path.join(entry, name));
      }
    }
  };
  visit(accountDir);
  return linked;
}
