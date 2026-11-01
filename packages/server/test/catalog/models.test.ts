import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelsResultSchema, type ModelCache } from "@aio/contracts";
import {
  MODEL_BASELINE,
  MODEL_SCAN_COMMAND,
  ModelCatalog,
  accountModels,
  parseModelId,
  parseScan,
  settingsDefaults,
  sortNewestFirst,
} from "../../src/catalog/index.js";
import type { DockerClient, RunOnceOptions } from "../../src/docker/types.js";
import type { HostEnv } from "../../src/records/env.js";
import { ApiError } from "../../src/records/errors.js";
import { tempDir } from "../tmp.js";

let home: string;
let env: HostEnv;
let now = new Date("2026-10-28T00:00:00Z");

beforeEach(() => {
  home = tempDir("models-");
  now = new Date("2026-10-28T00:00:00Z");
  env = { home, user: "tester", now: () => now };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("ids", () => {
  it("parses ids with an optional minor and context suffix", () => {
    expect(parseModelId("claude-opus-5-5[1m]")).toEqual({ family: "opus", major: 5, minor: 5 });
    expect(parseModelId("claude-sonnet-5")).toEqual({ family: "sonnet", major: 5, minor: 0 });
    expect(parseModelId("gpt-5")).toBeUndefined();
  });
  it("sorts by family, then newest, then plain before [1m]", () => {
    expect(
      sortNewestFirst([
        "claude-haiku-5-5",
        "claude-opus-4-8",
        "claude-opus-5-5[1m]",
        "claude-opus-5-5",
        "x",
        "claude-fable-5",
      ]),
    ).toEqual([
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-opus-5-5[1m]",
      "claude-opus-4-8",
      "claude-haiku-5-5",
      "x",
    ]);
  });
  it("keeps 4.5 and later from a scan", () => {
    expect(
      parseScan(
        "claude-opus-4-1\nclaude-sonnet-4-5\nclaude-opus-3\n claude-opus-5 \nclaude-opus-5\nbogus\n",
      ),
    ).toEqual(["claude-opus-5", "claude-sonnet-4-5"]);
  });
  it("has the verbatim scan command", () => {
    expect(MODEL_SCAN_COMMAND).toBe(
      "f=$(readlink -f \"$(command -v claude)\") && grep -aoE 'claude-(opus|sonnet|haiku|fable)-[0-9]+(-[0-9]{1,2})?([^0-9a-z-]|$)' \"$f\" | sed -E 's/[^0-9a-z-]+$//' | sort -u",
    );
  });
});

describe("account models and settings defaults", () => {
  it("reads additionalModelOptionsCache", () => {
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-opus-9" }, { label: "x" }] }),
    );
    expect(accountModels(env)).toEqual(["claude-opus-9"]);
  });
  it("applies the settings precedence and fallbacks", () => {
    const dir = path.join(home, "proj");
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    expect(settingsDefaults(env, dir)).toEqual({ model: "claude-opus-5-5", effort: "high" });
    fs.writeFileSync(
      path.join(home, ".claude/settings.json"),
      JSON.stringify({ model: "user-m", effortLevel: "low" }),
    );
    fs.writeFileSync(
      path.join(dir, ".claude/settings.json"),
      JSON.stringify({ model: "proj-m", effortLevel: "bogus" }),
    );
    fs.writeFileSync(
      path.join(dir, ".claude/settings.local.json"),
      JSON.stringify({ effortLevel: "max" }),
    );
    expect(settingsDefaults(env, dir)).toEqual({ model: "proj-m", effort: "max" });
    fs.writeFileSync(path.join(dir, ".claude/settings.local.json"), "{}");
    expect(settingsDefaults(env, dir)).toEqual({ model: "proj-m", effort: "low" });
    expect(settingsDefaults(env)).toEqual({ model: "user-m", effort: "low" });
  });
});

function fakeDocker(opts: {
  imageId?: string;
  scan?: { exitCode: number | null; stdout: string };
}) {
  const runs: RunOnceOptions[] = [];
  const docker = {
    inspectImage: async () =>
      opts.imageId ? { id: opts.imageId, created: "2026-01-01T00:00:00Z", labels: {} } : null,
    runOnce: async (o: RunOnceOptions) => {
      runs.push(o);
      return { exitCode: opts.scan?.exitCode ?? 0, stdout: opts.scan?.stdout ?? "", stderr: "" };
    },
  } as unknown as DockerClient;
  return { docker, runs };
}

function catalog(docker: DockerClient, initial?: ModelCache) {
  let cache = initial;
  const c = new ModelCatalog({
    env,
    docker,
    image: () => "aio-agent",
    getCache: () => cache,
    setCache: (v) => {
      cache = v;
    },
  });
  return { c, cache: () => cache };
}

describe("ModelCatalog", () => {
  it("uses the baseline plus account models before a scan", async () => {
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-opus-9" }] }),
    );
    const { c } = catalog(fakeDocker({}).docker);
    const res = ModelsResultSchema.parse(await c.list());
    expect(res.source).toBe("baseline");
    expect(res.models[0]).toBe("claude-fable-5-1");
    expect(res.models).toContain("claude-opus-9");
    expect(res.models).toHaveLength(MODEL_BASELINE.length + 1);
    expect(res.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("refreshes only when stale", async () => {
    const { docker, runs } = fakeDocker({
      imageId: "sha:1",
      scan: { exitCode: 0, stdout: "claude-opus-6\n" },
    });
    const { c, cache } = catalog(docker);
    expect(await c.refreshIfStale()).toBe(true);
    expect(runs[0]).toMatchObject({
      image: "aio-agent",
      entrypoint: ["sh"],
      cmd: ["-c", MODEL_SCAN_COMMAND],
    });
    expect(cache()).toEqual({
      imageId: "sha:1",
      scannedAt: now.toISOString(),
      models: ["claude-opus-6"],
    });
    expect(await c.refreshIfStale()).toBe(false);
    now = new Date("2026-12-28T00:00:00Z");
    expect(await c.refreshIfStale()).toBe(true);
    expect(runs).toHaveLength(2);
    expect((await c.list()).source).toBe("cache");
  });

  it("does nothing without an image and keeps the cache on an empty scan", async () => {
    expect(await catalog(fakeDocker({}).docker).c.refreshIfStale()).toBe(false);
    const old: ModelCache = {
      imageId: "sha:0",
      scannedAt: now.toISOString(),
      models: ["claude-opus-5"],
    };
    const { c, cache } = catalog(
      fakeDocker({ imageId: "sha:1", scan: { exitCode: 0, stdout: "junk" } }).docker,
      old,
    );
    expect(await c.refreshIfStale()).toBe(false);
    expect(cache()).toBe(old);
  });

  it("rescans on demand and reports a missing image", async () => {
    const { c } = catalog(
      fakeDocker({ imageId: "sha:1", scan: { exitCode: 0, stdout: "claude-sonnet-6\n" } }).docker,
    );
    const res = await c.rescan();
    expect(res.source).toBe("scan");
    expect(res.models).toContain("claude-sonnet-6");
    const missing = catalog(fakeDocker({}).docker).c;
    await expect(missing.rescan()).rejects.toBeInstanceOf(ApiError);
    await expect(missing.rescan()).rejects.toMatchObject({ code: "image_missing" });
  });
});
