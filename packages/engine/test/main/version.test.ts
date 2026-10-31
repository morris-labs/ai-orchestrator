import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { engineIdentity } from "../../src/main/version.js";
import { tempDir } from "../tmp.js";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/write-identity.mjs",
);

describe("engineIdentity", () => {
  it("appends the content hash to the version", () => {
    expect(engineIdentity("4.0.0-dev", "0123456789ab\n")).toBe("4.0.0-dev+0123456789ab");
  });

  it("is the plain version without a hash", () => {
    expect(engineIdentity("4.0.0-dev", null)).toBe("4.0.0-dev");
    expect(engineIdentity("4.0.0-dev", " \n")).toBe("4.0.0-dev");
  });
});

describe("scripts/write-identity.mjs", () => {
  // Runs a copy of the script in a scratch package, so it hashes that
  // package's dist/ and not the real one.
  function run(pkg: string): string {
    execFileSync(process.execPath, [path.join(pkg, "scripts", "write-identity.mjs")]);
    return fs.readFileSync(path.join(pkg, "dist", "identity"), "utf8").trim();
  }

  function scratch(): string {
    const pkg = tempDir("engine-identity-");
    fs.mkdirSync(path.join(pkg, "scripts"));
    fs.mkdirSync(path.join(pkg, "dist", "sub"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(pkg, "scripts", "write-identity.mjs"));
    fs.writeFileSync(path.join(pkg, "dist", "index.js"), "export const a = 1;\n");
    fs.writeFileSync(path.join(pkg, "dist", "sub", "x.js"), "export const b = 2;\n");
    return pkg;
  }

  it("writes a short hex hash that changes with the engine code", () => {
    const pkg = scratch();
    const first = run(pkg);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    fs.writeFileSync(path.join(pkg, "dist", "sub", "x.js"), "export const b = 3;\n");
    expect(run(pkg)).not.toBe(first);
  });

  it("is the same for the same code, and ignores the identity file itself", () => {
    const pkg = scratch();
    expect(run(pkg)).toBe(run(pkg));
  });
});
