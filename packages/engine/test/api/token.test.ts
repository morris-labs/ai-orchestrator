// The engine token: read from the named file, or taken from the environment.
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type EngineEnv } from "@agentbox/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEngineToken } from "../../src/main/token.js";
import { TOKEN } from "./fixtures.js";
import { tempDir } from "../tmp.js";

let dir: string;
beforeEach(() => {
  dir = tempDir("engine-token-");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = (extra: Partial<EngineEnv>): EngineEnv => extra as EngineEnv;

describe("loadEngineToken", () => {
  it("prefers the named file over the token and trims it", () => {
    const file = path.join(dir, "engine.token");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    const r = loadEngineToken(
      env({ AGENTBOX_ENGINE_TOKEN_FILE: file, AGENTBOX_ENGINE_TOKEN: "other-token-0123456789" }),
    );
    expect(r).toEqual({ ok: true, token: TOKEN });
  });

  it("uses the token from the environment when no file is named", () => {
    const r = loadEngineToken(env({ AGENTBOX_ENGINE_TOKEN: TOKEN }), () => {
      throw new Error("must not read");
    });
    expect(r).toEqual({ ok: true, token: TOKEN });
  });

  it("names a missing, empty, or short file without its content", () => {
    const file = path.join(dir, "engine.token");
    expect(loadEngineToken(env({ AGENTBOX_ENGINE_TOKEN_FILE: file }))).toEqual({
      ok: false,
      problem: `The engine token file ${file} can't be read (ENOENT).`,
    });
    expect(loadEngineToken(env({ AGENTBOX_ENGINE_TOKEN_FILE: "/t" }), () => "  \n")).toEqual({
      ok: false,
      problem: "The engine token file /t is empty.",
    });
    const short = loadEngineToken(env({ AGENTBOX_ENGINE_TOKEN_FILE: "/t" }), () => "short-secret");
    expect(short.ok).toBe(false);
    expect(JSON.stringify(short)).not.toContain("short-secret");
  });
});
