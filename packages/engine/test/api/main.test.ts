// The entry point's pieces: arguments, environment, adapter selection, the
// active-runs file, and a full start and stop.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { BUILD_SOCKET_ROUTES, type EngineEnv, type Vendor } from "@aio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startActiveRunsWriter, writeActiveRuns } from "../../src/main/active-runs.js";
import { MockAdapter } from "../../src/adapters/mock.js";
import { FixOutputSchema, ReviewOutputSchema } from "../../src/core.js";
import {
  createMockAdapters,
  engineConfigDir,
  parseMockVendors,
  selectAdapters,
} from "../../src/main/adapters.js";
import { silentLogger } from "../../src/main/logger.js";
import { checkEnv, parseArgs, startEngine } from "../../src/main/run.js";
import { readPackageVersion } from "../../src/main/version.js";
import { CONTAINER, PROJECT_ROOT, TOKEN, fakeRunManager } from "./fixtures.js";
import { tempDir } from "../tmp.js";
import { PLAN, send } from "../build-socket/helpers.js";

let dir: string;
beforeEach(() => {
  dir = tempDir("engine-main-");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    AIO_ENGINE_TOKEN: TOKEN,
    AIO_PROJECT_ROOT: PROJECT_ROOT,
    AIO_CONTAINER: CONTAINER,
    AIO_ENGINE_VERSION: "1.0.0-dev",
  };

  it("parses a complete environment with the default port", () => {
    const r = checkEnv(good);
    expect(r.ok && r.env.AIO_ENGINE_PORT).toBe(20411);
  });

  it("refuses to start without a token and never echoes values", () => {
    const r = checkEnv({ ...good, AIO_ENGINE_TOKEN: undefined });
    expect(r).toEqual({
      ok: false,
      problems: ["Set AIO_ENGINE_TOKEN_FILE or AIO_ENGINE_TOKEN."],
    });
    const short = checkEnv({ ...good, AIO_ENGINE_TOKEN: "short-secret" });
    expect(short.ok).toBe(false);
    expect(JSON.stringify(short)).not.toContain("short-secret");
  });

  it("accepts the token file instead of the token", () => {
    const r = checkEnv({
      ...good,
      AIO_ENGINE_TOKEN: undefined,
      AIO_ENGINE_TOKEN_FILE: "/run/aio/engine.token",
    });
    expect(r.ok && r.env.AIO_ENGINE_TOKEN_FILE).toBe("/run/aio/engine.token");
  });

  it("defaults the state directory to /run/aio", () => {
    const r = checkEnv(good);
    expect(r.ok && r.env.AIO_STATE_DIR).toBe("/run/aio");
    const set = checkEnv({ ...good, AIO_STATE_DIR: "/tmp/state" });
    expect(set.ok && set.env.AIO_STATE_DIR).toBe("/tmp/state");
  });

  it("reports a bad port", () => {
    const r = checkEnv({ ...good, AIO_ENGINE_PORT: "99999" });
    expect(r.ok).toBe(false);
  });
});

describe("parseMockVendors", () => {
  it("reads 1 as every vendor and a list as those vendors", () => {
    expect(parseMockVendors("1")).toEqual(["claude", "codex", "copilot"]);
    expect(parseMockVendors("codex,copilot")).toEqual(["codex", "copilot"]);
    expect(parseMockVendors(" Codex , codex,")).toEqual(["codex"]);
  });

  it("reads an absent, empty, or 0 value as no vendor", () => {
    expect(parseMockVendors(undefined)).toEqual([]);
    expect(parseMockVendors("")).toEqual([]);
    expect(parseMockVendors("0")).toEqual([]);
  });

  it("rejects an unknown vendor", () => {
    expect(() => parseMockVendors("codex,gemini")).toThrow(/unknown vendor "gemini"/);
  });
});

describe("engineConfigDir", () => {
  it("reads the account folders from the server's mount by default", () => {
    expect(engineConfigDir({})).toBe("/run/aio-config");
    expect(engineConfigDir({ AIO_ENGINE_CONFIG_DIR: "" })).toBe("/run/aio-config");
  });

  it("reads them from AIO_ENGINE_CONFIG_DIR when it's set, so a test engine skips the live accounts", () => {
    expect(engineConfigDir({ AIO_ENGINE_CONFIG_DIR: dir })).toBe(dir);
  });
});

describe("selectAdapters", () => {
  it("uses mock adapters for every vendor with AIO_MOCK_VENDORS=1", async () => {
    const r = await selectAdapters({ AIO_MOCK_VENDORS: "1" }, silentLogger);
    expect(r.mock).toBe(true);
    expect(Object.keys(r.adapters).sort()).toEqual(["claude", "codex", "copilot"]);
    const review = await r.adapters.codex?.review({
      prompt: "Review group G-1",
      repoPath: dir,
      toolPolicy: "read-only",
      timeoutMs: 1_000,
    });
    expect(review).toMatchObject({ output: { findings: [], ledger: [] }, model: "mock-codex" });
  });

  it("puts a script's responses before the defaults", async () => {
    const file = path.join(dir, "mock.json");
    const finding = {
      severity: "P2",
      title: "Off by one",
      file: "a.py",
      lines: [1, 2],
      failure_case: "x",
      category: "correctness",
      introduced: true,
    };
    writeFileSync(
      file,
      JSON.stringify({
        claude: { responses: [{ method: "review", output: { findings: [finding] } }] },
      }),
    );
    const adapters = createMockAdapters(file);
    const base = { prompt: "p", cwd: dir, tools: "read-only" as const, timeoutMs: 1_000 };
    const out = await adapters.claude.review({ ...base, outputSchema: ReviewOutputSchema });
    expect(out.output.findings).toHaveLength(1);
    const fix = await adapters.claude.fix({ ...base, outputSchema: FixOutputSchema });
    expect(fix.output).toEqual({ fixed: [], notFixed: [], summary: "" });
  });

  it("leaves out a vendor whose CLI doesn't answer", async () => {
    const cli = (vendor: Vendor, available: boolean) =>
      new MockAdapter({
        vendor,
        health: { available, version: available ? "1.0" : null },
        responses: [],
      });
    const r = await selectAdapters({}, silentLogger, () => ({
      claude: cli("claude", true),
      codex: cli("codex", false),
      copilot: cli("copilot", false),
    }));
    expect(Object.keys(r.adapters)).toEqual(["claude"]);
    expect(r.missing.map((m) => m.vendor)).toEqual(["codex", "copilot"]);
  });

  it("mocks only the vendors a list names and checks the others' CLIs", async () => {
    const health: Vendor[] = [];
    const cli = (vendor: Vendor) =>
      new MockAdapter({
        vendor,
        health: { available: true, version: "9.9" },
        responses: [],
      });
    const r = await selectAdapters({ AIO_MOCK_VENDORS: "codex, copilot" }, silentLogger, () => {
      const all = { claude: cli("claude"), codex: cli("codex"), copilot: cli("copilot") };
      for (const [v, a] of Object.entries(all) as [Vendor, MockAdapter][]) {
        const real = a.health.bind(a);
        a.health = async () => {
          health.push(v);
          return real();
        };
      }
      return all;
    });
    expect(r.mock).toBe(false);
    expect(r.mocked).toEqual(["codex", "copilot"]);
    expect(Object.keys(r.adapters).sort()).toEqual(["claude", "codex", "copilot"]);
    expect(health).toEqual(["claude"]);
    const review = await r.adapters.copilot?.review({
      prompt: "Review group G-1",
      repoPath: dir,
      toolPolicy: "read-only",
      timeoutMs: 1_000,
    });
    expect(review).toMatchObject({ model: "mock-copilot" });
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
      AIO_ENGINE_TOKEN: TOKEN,
      AIO_ENGINE_PORT: 0,
      AIO_PROJECT_ROOT: dir,
      AIO_CONTAINER: CONTAINER,
      AIO_ENGINE_VERSION: readPackageVersion(),
    } as unknown as EngineEnv;
    const runs = fakeRunManager();
    const handle = await startEngine({
      env,
      token: TOKEN,
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

describe("startEngine with the real core", () => {
  it("serves an empty run list and writes active-runs to AIO_STATE_DIR", async () => {
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir);
    const env = {
      AIO_ENGINE_TOKEN: TOKEN,
      AIO_ENGINE_PORT: 0,
      AIO_PROJECT_ROOT: dir,
      AIO_CONTAINER: CONTAINER,
      AIO_ENGINE_VERSION: "0.0.0-other",
      AIO_STATE_DIR: stateDir,
    } as unknown as EngineEnv;
    const handle = await startEngine({
      env,
      token: TOKEN,
      log: silentLogger,
      host: "127.0.0.1",
      runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
    });
    try {
      const base = `http://127.0.0.1:${handle.address.port}/api/v1`;
      const health = await fetch(`${base}/health`);
      expect(await health.json()).toMatchObject({ versionMatches: false });
      const runs = await fetch(`${base}/runs`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(await runs.json()).toEqual({ runs: [] });
      expect(readFileSync(path.join(stateDir, "active-runs"), "utf8")).toBe("0\n");
    } finally {
      await handle.close();
    }
  });

  it("runs the team chat bus on the loopback interface and stops it", async () => {
    const env = {
      AIO_ENGINE_TOKEN: TOKEN,
      AIO_ENGINE_PORT: 0,
      AIO_PROJECT_ROOT: dir,
      AIO_CONTAINER: CONTAINER,
      AIO_ENGINE_VERSION: readPackageVersion(),
    } as unknown as EngineEnv;
    const handle = await startEngine({
      env,
      token: TOKEN,
      log: silentLogger,
      stateDir: dir,
      host: "127.0.0.1",
      runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
    });
    const url = handle.team.url;
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      // The engine token isn't a bus token.
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.close();
    }
    await expect(fetch(url, { method: "POST" })).rejects.toThrow();
  });
});

describe("startEngine with a build socket", () => {
  it("serves build requests for the project in AIO_PROJECT_ID and removes the socket at shutdown", async () => {
    const socket = path.join(dir, "sock", "build.sock");
    const env = {
      AIO_ENGINE_TOKEN: TOKEN,
      AIO_ENGINE_PORT: 0,
      AIO_PROJECT_ROOT: dir,
      AIO_CONTAINER: CONTAINER,
      AIO_ENGINE_VERSION: readPackageVersion(),
      AIO_PROJECT_ID: "proj-1",
    } as unknown as EngineEnv;
    const handle = await startEngine({
      env,
      token: TOKEN,
      log: silentLogger,
      stateDir: dir,
      host: "127.0.0.1",
      runs: fakeRunManager(),
      buildSocket: socket,
      runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
    });
    try {
      const missing = await send(socket, "POST", BUILD_SOCKET_ROUTES.status, {
        projectId: "proj-1",
        boxId: null,
        slug: "cart-total",
      });
      expect(missing.status).toBe(404);
      const other = await send(socket, "POST", BUILD_SOCKET_ROUTES.start, {
        projectId: "proj-2",
        boxId: null,
        slug: "cart-total",
        plan: PLAN,
      });
      expect(other).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
      expect(existsSync(path.join(dir, ".aio", "builds", "cart-total"))).toBe(false);
    } finally {
      await handle.close();
    }
    expect(existsSync(socket)).toBe(false);
  });

  it("starts without the socket when another process holds it", async () => {
    const socket = path.join(dir, "build.sock");
    const holder = net.createServer().listen(socket);
    await new Promise((resolve) => holder.once("listening", resolve));
    const warnings: string[] = [];
    const log = { ...silentLogger, warn: (message: string) => warnings.push(message) };
    const handle = await startEngine({
      env: {
        AIO_ENGINE_TOKEN: TOKEN,
        AIO_ENGINE_PORT: 0,
        AIO_PROJECT_ROOT: dir,
        AIO_CONTAINER: CONTAINER,
        AIO_ENGINE_VERSION: readPackageVersion(),
      } as unknown as EngineEnv,
      token: TOKEN,
      log,
      stateDir: dir,
      host: "127.0.0.1",
      runs: fakeRunManager(),
      buildSocket: socket,
      runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
    });
    await handle.close();
    await new Promise((resolve) => holder.close(resolve));
    expect(warnings.join("\n")).toMatch(/build socket/);
  });
});
