// Hard-link snapshots of the transcript store.
//
// A snapshot is a copy of the store's folder tree in which every file is a
// hard link to the store's file (like `cp -al`). It costs one directory entry
// per file and no file content, so it takes seconds and almost no space.
//
// What it protects against: a file that is deleted or replaced in the store
// by another process, such as Claude Code's cleanup of old transcripts. The
// snapshot keeps the old link, so the content survives.
//
// What it doesn't protect against: an edit in place. A transcript is appended
// to while a conversation runs, and an appended file is the same file in the
// snapshot. It also can't cross a file system, so the store and
// `DATA_DIR/backup` must be on the same one.
import fs from "node:fs";
import path from "node:path";

/** Snapshots to keep when the `transcriptBackupKeep` setting is absent. */
export const DEFAULT_BACKUP_KEEP = 7;

const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/;

export interface SnapshotResult {
  /** The new snapshot folder, or `undefined` when the store doesn't exist. */
  dir?: string;
  files: number;
  /** Snapshots deleted to stay within `keep`. */
  pruned: string[];
}

/** The snapshot folder name for a time: `2026-11-01T04-10-18Z`. */
export function snapshotName(now: Date): string {
  return `${now.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}

async function linkTree(from: string, to: string): Promise<number> {
  await fs.promises.mkdir(to, { recursive: true, mode: 0o700 });
  let files = 0;
  for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) files += await linkTree(src, dst);
    else if (entry.isSymbolicLink()) {
      await fs.promises.symlink(await fs.promises.readlink(src), dst);
    } else if (entry.isFile()) {
      await fs.promises.link(src, dst);
      files += 1;
    }
  }
  return files;
}

/** The snapshot folders in `backupRoot`, oldest first. */
export function listSnapshots(backupRoot: string): string[] {
  try {
    return fs
      .readdirSync(backupRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SNAPSHOT_NAME.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Takes a snapshot of `storeRoot` into `backupRoot/TIMESTAMP`, then deletes
 * the oldest snapshots beyond `keep`. A failed snapshot is removed again and
 * the error thrown; older snapshots stay. With `keep` of 0, does nothing.
 */
export async function snapshotTranscripts(options: {
  storeRoot: string;
  backupRoot: string;
  keep: number;
  now: Date;
}): Promise<SnapshotResult> {
  const { storeRoot, backupRoot, keep, now } = options;
  const none: SnapshotResult = { files: 0, pruned: [] };
  if (keep <= 0) return none;
  if (!fs.existsSync(storeRoot)) return none;
  // The store itself may be a link, as the host's `projects` is.
  const real = fs.realpathSync(storeRoot);
  let name = snapshotName(now);
  for (let n = 2; fs.existsSync(path.join(backupRoot, name)); n += 1) {
    name = `${snapshotName(now)}-${n}`;
  }
  const dir = path.join(backupRoot, name);
  let files: number;
  try {
    files = await linkTree(real, dir);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === "EXDEV"
        ? `${backupRoot} and the transcript store ${real} are on different file systems, so hard links can't link them.`
        : `Can't snapshot ${real} into ${dir}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const pruned: string[] = [];
  const all = listSnapshots(backupRoot);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    // A snapshot holds only links, so this deletes no store file.
    fs.rmSync(path.join(backupRoot, old), { recursive: true, force: true });
    pruned.push(old);
  }
  return { dir, files, pruned };
}
