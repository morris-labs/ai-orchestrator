// The engine token file: where it is, and how it fills the environment.
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineTokenFile, loadEngineToken } from "../../src/main/token.js";
import { TOKEN } from "./fixtures.js";
import { tempDir } from "../tmp.js";

let dir: string;
beforeEach(() => {
  dir = tempDir("engine-token-");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("engineTokenFile", () => {
  it("defaults to engine.token in the state directory", () => {
    expect(engineTokenFile({})).toBe("/run/claude-box/engine.token");
    expect(engineTokenFile({ AGENTBOX_STATE_DIR: "/s" })).toBe("/s/engine.token");
    expect(engineTokenFile({ AGENTBOX_ENGINE_TOKEN_FILE: "/t/tok" })).toBe("/t/tok");
  });
});

describe("loadEngineToken", () => {
  it("reads the token from the named file and trims it", () => {
    const file = path.join(dir, "engine.token");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    const r = loadEngineToken({ AGENTBOX_ENGINE_TOKEN_FILE: file, AGENTBOX_ENGINE_TOKEN: "other" });
    expect(r.ok && r.env.AGENTBOX_ENGINE_TOKEN).toBe(TOKEN);
  });

  it("reads the default file in the state directory", () => {
    writeFileSync(path.join(dir, "engine.token"), TOKEN);
    const r = loadEngineToken({ AGENTBOX_STATE_DIR: dir });
    expect(r.ok && r.env.AGENTBOX_ENGINE_TOKEN).toBe(TOKEN);
  });

  it("keeps a token from the environment when no file is named", () => {
    const env = { AGENTBOX_ENGINE_TOKEN: TOKEN };
    const r = loadEngineToken(env, () => {
      throw new Error("must not read");
    });
    expect(r).toEqual({ ok: true, env });
  });

  it("names a missing or empty file without its content", () => {
    const missing = loadEngineToken({ AGENTBOX_STATE_DIR: dir });
    expect(missing).toEqual({
      ok: false,
      problem: `The engine token file ${dir}/engine.token can't be read (ENOENT).`,
    });
    const r = loadEngineToken({}, () => "  \n");
    expect(r).toEqual({
      ok: false,
      problem: "The engine token file /run/claude-box/engine.token is empty.",
    });
  });
});
