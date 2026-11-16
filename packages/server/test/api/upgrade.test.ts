import { describe, expect, it, vi } from "vitest";
import { apiCoreOf } from "../../src/api/core-adapter.js";
import { UpgradeService } from "../../src/setup/upgrade.js";
import { makeHarness } from "../boxes/harness.js";
import path from "node:path";
import type Docker from "dockerode";
import { createApiServer } from "../../src/api/server.js";
import { AUTH, createHarness } from "./harness.js";

describe("upgrade through the server core API with MemoryDocker", () => {
  it("persists open boxes across coordinator restart, recreates busy and idle containers, and resumes conversations", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      conversationName: "Working",
      start: true,
    });
    const idle = h.core.projects.create({ root: h.dir("idle") });
    await h.core.projects.ensureContainer(idle.id);
    const before = await h.docker.listContainers({ all: true });
    const core = apiCoreOf(h.core, {} as Docker);
    const recordFile = path.join(h.home, "upgrade.json");
    const options = {
      core,
      recordFile,
      build: async () => "latest" as const,
      runs: () => [],
      resume: async () => {},
    };
    await new UpgradeService(options).prepare();
    const base = await createHarness();
    const api = await createApiServer({ ...base.deps, core, upgrade: new UpgradeService(options) });
    const response = await api.app.inject({
      method: "POST",
      url: "/api/v1/upgrade",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    await api.close();
    await base.server.close();
    expect(report.boxes).toEqual([{ id: box.id, name: "Working", restored: true, reason: null }]);
    expect((await core.boxes.get(box.id)).status).toBe("running");
    const after = await h.docker.listContainers({ all: true });
    expect(after).toHaveLength(2);
    expect(after.every((c) => !before.some((old) => old.id === c.id))).toBe(true);
  });
});

describe("upgrade recovery reports", () => {
  it("reports a refused newer run and restores another in-progress run", async () => {
    const h = makeHarness();
    const project = h.core.projects.create({ root: h.dir("reviews") });
    const resumed: string[] = [];
    const upgrade = new UpgradeService({
      core: apiCoreOf(h.core, {} as Docker),
      recordFile: path.join(h.home, "runs.json"),
      build: async () => "pinned",
      runs: () => [
        { id: "old-run", projectId: project.id, status: "running" },
        { id: "future-run", projectId: project.id, status: "running" },
        { id: "paused-run", projectId: project.id, status: "paused" },
      ],
      resume: async (_, id) => {
        if (id === "future-run")
          throw new Error("Saved by state version 99 (AI Orchestrator 9.0.0)");
        resumed.push(id);
      },
    });
    expect((await upgrade.preview()).runs.map((r) => r.run_id)).toEqual(["old-run", "future-run"]);
    const report = await upgrade.start();
    expect(report.fallback).toBe(true);
    expect(resumed).toEqual(["old-run"]);
    expect(report.runs).toEqual([
      { run_id: "old-run", name: "old-run", restored: true, reason: null },
      {
        run_id: "future-run",
        name: "future-run",
        restored: false,
        reason: "Saved by state version 99 (AI Orchestrator 9.0.0)",
      },
    ]);
  });
  it("leaves all containers and open work untouched when both builds fail", async () => {
    const h = makeHarness();
    await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root", start: true });
    const before = await h.docker.listContainers({ all: true });
    const upgrade = new UpgradeService({
      core: apiCoreOf(h.core, {} as Docker),
      recordFile: path.join(h.home, "failed.json"),
      build: async () => {
        throw new Error("Both builds failed");
      },
      runs: () => [],
      resume: async () => {},
    });
    const report = await upgrade.start();
    expect(report).toMatchObject({ image: "failed", error: "Both builds failed" });
    expect(await h.docker.listContainers({ all: true })).toEqual(before);
  });
  it("holds starts while building and releases the wait when the image is ready", async () => {
    const h = makeHarness();
    let finish!: () => void;
    const building = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const upgrade = new UpgradeService({
      core: apiCoreOf(h.core, {} as Docker),
      recordFile: path.join(h.home, "waiting.json"),
      build: async () => {
        await building;
        return "latest";
      },
      runs: () => [],
      resume: async () => {},
    });
    const upgrading = upgrade.start();
    expect(upgrade.upgrading).toBe(true);
    let ready = false;
    const held = upgrade.waitReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    finish();
    await upgrading;
    await held;
    expect(ready).toBe(true);
    expect(upgrade.upgrading).toBe(false);
  });
});

describe("upgrade deadlines", () => {
  it("ends a stalled image build without touching containers", async () => {
    const h = makeHarness();
    const service = new UpgradeService({
      core: apiCoreOf(h.core, {} as Docker),
      recordFile: path.join(h.home, "timeout.json"),
      timeoutMs: 10,
      build: () => new Promise(() => {}),
      runs: () => [],
      resume: async () => {},
    });
    const report = await service.start();
    expect(report.error).toBe("Upgrade time limit reached");
    expect(service.upgrading).toBe(false);
  });
});

describe("upgrade recovery records", () => {
  it("retains timed out work and retries restoration without rebuilding or recreating containers", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root", start: true });
    const core = apiCoreOf(h.core, {} as Docker);
    const recreate = core.projects.recreateContainer!;
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const build = vi.fn(async () => "latest" as const);
    const recreateSpy = vi.fn(async (id: string) => {
      await recreate(id);
      now = 100;
    });
    core.projects.recreateContainer = recreateSpy;
    const options = {
      core,
      build,
      recordFile: path.join(h.home, "recovery.json"),
      timeoutMs: 50,
      runs: () => [],
      resume: async () => {},
    };
    try {
      const first = new UpgradeService(options);
      const report = await first.start();
      expect(report.boxes[0]).toMatchObject({ id: box.id, restored: false });
      expect(first.hasOpenWork).toBe(true);
      const second = new UpgradeService(options);
      expect((await second.start()).boxes[0]).toMatchObject({ id: box.id, restored: true });
      expect(build).toHaveBeenCalledTimes(1);
      expect(recreateSpy).toHaveBeenCalledTimes(1);
      expect(second.hasOpenWork).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves unrestored work and includes newly opened work when preparing again", async () => {
    const h = makeHarness();
    const old = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root", start: true });
    const core = apiCoreOf(h.core, {} as Docker);
    const start = core.boxes.start;
    core.boxes.start = async () => {
      throw new Error("restore failed");
    };
    const service = new UpgradeService({
      core,
      recordFile: path.join(h.home, "fresh.json"),
      build: async () => "latest",
      runs: () => [],
      resume: async () => {},
    });
    await service.start();
    core.boxes.start = start;
    const fresh = await h.core.boxes.create({
      targetDir: h.dir("new"),
      layout: "root",
      start: true,
    });
    expect((await service.prepare()).boxes.map((box) => box.id)).toEqual([old.id, fresh.id]);
    const report = await service.start();
    expect(report.boxes.map((box) => box.id)).toEqual([old.id, fresh.id]);
    expect((await core.boxes.get(old.id)).status).toBe("running");
  });
});
