// Checks on scripts/ensure-electron.sh against a fake checkout: an electron
// package that has no binary, as when pnpm reuses a module tree and skips
// the package's install script.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(ROOT, "scripts/ensure-electron.sh");

let fake: string;
let pkg: string;

/** A package whose install.js creates the binary, like Electron's does. */
function writePackage(installBody: string): void {
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "install.js"), installBody);
  for (const app of ["boxes", "review"]) {
    const modules = path.join(fake, "apps", app, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(pkg, path.join(modules, "electron"));
  }
}

const INSTALL_OK = `
const fs = require("node:fs");
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/electron", "binary", { mode: 0o777 });
fs.chmodSync("dist/electron", 0o777);
fs.writeFileSync("dist/chrome-sandbox", "helper");
fs.chmodSync("dist/chrome-sandbox", 0o777);
fs.writeFileSync("path.txt", "electron");
`;

function run(...args: string[]) {
  const env = { ...process.env };
  delete env.TMUX;
  return spawnSync("bash", [SCRIPT, "--root", fake, ...args], { encoding: "utf8", env });
}

beforeEach(() => {
  fake = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-ensure-electron-"));
  pkg = path.join(fake, "store", "electron");
});

afterEach(() => {
  fs.rmSync(fake, { recursive: true, force: true });
});

describe("ensure-electron.sh", () => {
  it("runs install.js when the package has no binary, and fixes the modes", () => {
    writePackage(INSTALL_OK);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(pkg, "path.txt"), "utf8")).toBe("electron");
    for (const file of ["electron", "chrome-sandbox"]) {
      const mode = fs.statSync(path.join(pkg, "dist", file)).mode & 0o777;
      expect(mode & 0o022, `${file} is ${mode.toString(8)}`).toBe(0);
      expect(mode & 0o700).toBe(0o700);
    }
  });

  it("reports a missing binary with --check and downloads nothing", () => {
    writePackage(INSTALL_OK);
    const result = run("--check");
    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(pkg, "path.txt"))).toBe(false);
  });

  it("leaves a complete package alone", () => {
    writePackage("process.exit(7);");
    fs.mkdirSync(path.join(pkg, "dist"));
    fs.writeFileSync(path.join(pkg, "dist/electron"), "binary");
    fs.writeFileSync(path.join(pkg, "path.txt"), "electron");
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(run("--check").status).toBe(0);
  });

  it("fails when install.js finishes without a binary", () => {
    writePackage("// downloads nothing");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("still missing");
  });
});
