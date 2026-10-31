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

describe("the built page", () => {
  it("carries a Content-Security-Policy that limits scripts and requests to its origin", () => {
    const file = path.join(import.meta.dirname, "../dist/renderer/index.html");
    let html: string;
    try {
      html = readFileSync(file, "utf8");
    } catch {
      throw new Error(`No built page at ${file}. Run \`pnpm build\` first.`);
    }
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(
      html.replace(/&#39;/g, "'"),
    );
    expect(meta).not.toBeNull();
    expect(meta![1]).toContain("script-src 'self'");
    expect(meta![1]).toContain("connect-src 'self'");
    // The policy must come before any script, or it doesn't cover them.
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
  });
});
