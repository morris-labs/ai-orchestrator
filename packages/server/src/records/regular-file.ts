// Reads and writes of small files in directories a container can also write,
// such as a keeper's state directory and a box's sessions directory. A
// container can leave a FIFO there, which blocks a plain read until a writer
// appears, or a symbolic link, which sends a read or write to any host file.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** The most a guarded read returns; a longer file reads as missing. */
export const REGULAR_FILE_MAX_BYTES = 1024 * 1024;

// O_NONBLOCK makes opening a FIFO return at once instead of waiting for a
// writer; a caller's fstat check then refuses it. O_NOFOLLOW refuses a link.
export const GUARDED_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/**
 * Reads a file only when it is a regular file, not a link, and at most
 * `maxBytes` long. Returns `null` otherwise, and when it can't be read.
 */
export function readRegularFileSync(
  file: string,
  maxBytes = REGULAR_FILE_MAX_BYTES,
): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, GUARDED_READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The asynchronous form of `readRegularFileSync()`. */
export async function readRegularFile(
  file: string,
  maxBytes = REGULAR_FILE_MAX_BYTES,
): Promise<string | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, GUARDED_READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Replaces `file` with `content` without following whatever is at that path:
 * the content goes to a fresh temporary file, created exclusively, that is
 * renamed over the path. A rename replaces a link rather than writing
 * through it; a directory in the way is removed first.
 */
export function replaceFileSync(file: string, content: string, mode = 0o644): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmp, content, { mode, flag: "wx" });
  try {
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EISDIR" && code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
      fs.rmSync(file, { recursive: true, force: true });
      fs.renameSync(tmp, file);
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
