#!/usr/bin/env node
// Reads or changes the subsystem field of a Windows PE executable.
//
// The Windows package ships a copy of node.exe whose subsystem is Windows
// GUI (2) instead of Windows console (3). Windows then starts it without a
// console window, which is what the logon task that runs the server needs.
// The code is the same Node.js; only the header field differs. Changing it
// invalidates any Authenticode signature, so the package signs the copy
// itself (see docs/platforms.md).
//
// Usage:
//   node scripts/lib/pe-subsystem.mjs FILE           Prints the subsystem.
//   node scripts/lib/pe-subsystem.mjs FILE gui       Sets it to Windows GUI.
//   node scripts/lib/pe-subsystem.mjs FILE console   Sets it to Windows console.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SUBSYSTEM_GUI = 2;
export const SUBSYSTEM_CONSOLE = 3;

/**
 * Returns the byte offset of the subsystem field in a PE image, or throws
 * when `buf` isn't one. The field sits 68 bytes into the optional header in
 * both PE32 and PE32+ images.
 */
export function subsystemOffset(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not an MZ executable");
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 + 70 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) {
    throw new Error("no PE header");
  }
  const optional = pe + 24;
  const magic = buf.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error("unknown optional header");
  return optional + 68;
}

/** Returns a copy of `buf` with the subsystem set to `value`. */
export function withSubsystem(buf, value) {
  const out = Buffer.from(buf);
  out.writeUInt16LE(value, subsystemOffset(out));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, mode] = process.argv.slice(2);
  if (!file) {
    process.stderr.write("Usage: pe-subsystem.mjs FILE [gui|console]\n");
    process.exit(2);
  }
  const buf = readFileSync(file);
  if (mode === undefined) {
    process.stdout.write(`${buf.readUInt16LE(subsystemOffset(buf))}\n`);
  } else if (mode === "gui" || mode === "console") {
    writeFileSync(file, withSubsystem(buf, mode === "gui" ? SUBSYSTEM_GUI : SUBSYSTEM_CONSOLE));
  } else {
    process.stderr.write(`Unknown mode ${mode}; use gui or console.\n`);
    process.exit(2);
  }
}
