// Atomic JSON file helpers for the run directory.
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZodType, ZodTypeDef } from "zod";

/**
 * Writes `data` to `path` through a temporary file in the same directory and
 * a rename, so a reader sees either the old file or the new one, never half.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, data, { flag: "wx" });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Writes `value` as indented JSON with a trailing newline, atomically. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Reads and parses a JSON file, validating it with `schema` when you give one.
 * Returns `undefined` when the file doesn't exist.
 */
export async function readJson<T>(
  path: string,
  schema?: ZodType<T, ZodTypeDef, unknown>,
): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  return schema ? schema.parse(value) : (value as T);
}

/** Appends one JSON line to `path`, creating the file and its directory. */
export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}
