// The entry point's pieces: arguments, environment, core loading, the
// active-runs file, and a full start and stop.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineEnv } from "@agentbox/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startActiveRunsWriter, writeActiveRuns } from "../../src/main/active-runs.js";
import { loadCore, unavailableRunManager } from "../../src/main/core-loader.js";
import { silentLogger } from "../../src/main/logger.js";
import { checkEnv, parseArgs, startEngine } from "../../src/main/run.js";
import { readPackageVersion } from "../../src/main/version.js";
import { CONTAINER, PROJECT_ROOT, TOKEN, fakeRunManager } from "./fixtures.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "engine-main-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = { projectRoot: PROJECT_ROOT, container: CONTAINER, log: silentLogger } as never;

describe("parseArgs", () => {
  it("reads the log level in both forms", () => {
    expect(parseArgs(["--log-level", "debug"]).logLevel).toBe("debug");
    expect(parseArgs(["--log-level=warn"]).logLevel).toBe("warn");
    expect(parseArgs([])).toEqual({ logLevel: null, help: false, version: false });
  });

  it("rejects a bad level and unknown arguments", () => {
    expect(() => parseArgs(["--log-level", "loud"])).toThrow(/log-level/);
    expect(() => parseArgs(["--log-level"])).toThrow(/log-level/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("checkEnv", () => {
  const good = {
    AGENTBOX_ENGINE_TOKEN: TOKEN,
    AGENTBOX_PROJECT_ROOT: PROJECT_ROOT,
    AGENTBOX_CONTAINER: CONTAINER,
    AGENTBOX_ENGINE_VERSION: "4.0.0-dev",
  };

  it("parses a complete environment with the default port", () => {
    const r = checkEnv(good);
    expect(r.ok && r.env.AGENTBOX_ENGINE_PORT).toBe(20411);
  });

  it("refuses to start without a token and never echoes values", () => {
    const r = checkEnv({ ...good, AGENTBOX_ENGINE_TOKEN: undefined });
    expect(r).toEqual({ ok: false, problems: ["AGENTBOX_ENGINE_TOKEN isn't set."] });
    const short = checkEnv({ ...good, AGENTBOX_ENGINE_TOKEN: "short-secret" });
    expect(short.ok).toBe(false);
    expect(JSON.stringify(short)).not.toContain("short-secret");
  });

  it("reports a bad port", () => {
    const r = checkEnv({ ...good, AGENTBOX_ENGINE_PORT: "99999" });
    expect(r.ok).toBe(false);
  });
});

describe("loadCore", () => {
  it("falls back to an unavailable core when core.js is missing", async () => {
    const r = await loadCore(deps, pathToFileURL(path.join(dir, "core.js")));
    expect(r.available).toBe(false);
    expect(await r.runs.list({})).toEqual([]);
    await expect(r.runs.pause("x")).rejects.toMatchObject({ code: "conflict" });
  });

  it("builds the run manager a core module exports", async () => {
    const file = path.join(dir, "core.mjs");
    writeFileSync(
      file,
      "export function createRunManager(d) { return { marker: d.container }; }\n",
    );
    const r = await loadCore(deps, pathToFileURL(file));
    expect(r).toEqual({ runs: { marker: CONTAINER }, available: true });
  });

  it("throws when the module has no createRunManager", async () => {
    const file = path.join(dir, "core.mjs");
    writeFileSync(file, "export const x = 1;\n");
    await expect(loadCore(deps, pathToFileURL(file))).rejects.toThrow(/createRunManager/);
  });

  it("propagates an error inside the core module", async () => {
    const file = path.join(dir, "core.mjs");
    writeFileSync(file, "import './missing-dep.mjs';\n");
    await expect(loadCore(deps, pathToFileURL(file))).rejects.toThrow(/missing-dep/);
  });

  it("gives the unavailable core no active runs", () => {
    expect(unavailableRunManager().activeRunCount()).toBe(0);
  });
});

describe("active-runs file", () => {
  it("writes the count atomically", () => {
    expect(writeActiveRuns(dir, 3)).toBe(true);
    expect(readFileSync(path.join(dir, "active-runs"), "utf8")).toBe("3\n");
    expect(writeActiveRuns(path.join(dir, "missing"), 1)).toBe(false);
  });

  it("writes on start and the final count on stop", () => {
    let n = 2;
    const w = startActiveRunsWriter(dir, () => n, silentLogger, 60_000);
    expect(readFileSync(path.join(dir, "active-runs"), "utf8")).toBe("2\n");
    n = 5;
    w.stop(0);
    expect(readFileSync(path.join(dir, "active-runs"), "utf8")).toBe("0\n");
  });
});

describe("startEngine", () => {
  it("starts, serves health, writes active-runs, and stops", async () => {
    const env = {
      AGENTBOX_ENGINE_TOKEN: TOKEN,
      AGENTBOX_ENGINE_PORT: 0,
      AGENTBOX_PROJECT_ROOT: dir,
      AGENTBOX_CONTAINER: CONTAINER,
      AGENTBOX_ENGINE_VERSION: readPackageVersion(),
    } as unknown as EngineEnv;
    const runs = fakeRunManager();
    const handle = await startEngine({
      env,
      log: silentLogger,
      stateDir: dir,
      host: "127.0.0.1",
      runs,
      runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.address.port}/api/v1/health`);
      expect(await res.json()).toMatchObject({ container: CONTAINER, versionMatches: true });
      expect(readFileSync(path.join(dir, "active-runs"), "utf8")).toBe("1\n");
    } finally {
      await handle.close();
    }
    expect(readFileSync(path.join(dir, "active-runs"), "utf8")).toBe("0\n");
    expect(runs.close).toHaveBeenCalledOnce();
  });
});
