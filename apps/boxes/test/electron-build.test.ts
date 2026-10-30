// Checks the built preload script: a sandboxed preload can require only a
// few built-in modules, so it must be one self-contained file. Run the build
// first; `pnpm test` at the repository root does.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PRELOAD = path.join(import.meta.dirname, "../dist/electron/preload.cjs");
/** The modules Electron's sandboxed `require` provides. */
const SANDBOX_MODULES = ["electron", "events", "timers", "url"];

function requires(code: string): string[] {
  return [...code.matchAll(/\brequire\(\s*(["'`])([^"'`]+)\1\s*\)/g)].map((m) => m[2] as string);
}

describe("the built preload", () => {
  it("requires no file of its own and only modules a sandboxed preload has", () => {
    let code: string;
    try {
      code = readFileSync(PRELOAD, "utf8");
    } catch {
      throw new Error(`No built preload at ${PRELOAD}. Run \`pnpm build\` first.`);
    }
    const found = requires(code);
    expect(found.filter((m) => m.startsWith(".") || m.startsWith("/"))).toEqual([]);
    expect(found.filter((m) => !SANDBOX_MODULES.includes(m.replace(/^node:/, "")))).toEqual([]);
    expect(found).toContain("electron");
  });
});
