// Copies the shipped role library into dist/, next to the compiled role
// loader, which reads it from there. The build scripts run this file after
// tsc and before write-identity.mjs, so the engine's identity hash covers
// the roles.
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "build", "roles", "library");
const to = path.join(root, "dist", "build", "roles", "library");
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
