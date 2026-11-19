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
  it("captures work opened after a failed build before startup recovery recreates containers", async () => {
    const h = makeHarness();
    const core = apiCoreOf(h.core, {} as Docker);
    const options = {
      core,
      recordFile: path.join(h.home, "startup.json"),
      runs: () => [],
      resume: async () => {},
    };
    await new UpgradeService({
      ...options,
      build: async () => {
        throw new Error("build failed");
      },
    }).start();
    const box = await h.core.boxes.create({
      targetDir: h.dir("fresh"),
      layout: "root",
      start: true,
    });
    const report = await new UpgradeService({ ...options, build: async () => "latest" }).start();
    expect(report.boxes).toContainEqual({ id: box.id, name: box.id, restored: true, reason: null });
    expect((await core.boxes.get(box.id)).status).toBe("running");
  });

  it("preserves prepared work and adds new work after a failed build", async () => {
    const h = makeHarness();
    const old = await h.core.boxes.create({ targetDir: h.dir("old"), layout: "root", start: true });
    const core = apiCoreOf(h.core, {} as Docker);
    let runs = [{ id: "old-run", projectId: old.projectId, status: "running" }];
    const resumed: string[] = [];
    const options = {
      core,
      recordFile: path.join(h.home, "prepared.json"),
      runs: () => runs,
      resume: async (_projectId: string, id: string) => {
        resumed.push(id);
      },
    };
    const service = new UpgradeService({
      ...options,
      build: async () => {
        throw new Error("build failed");
      },
    });
    await service.start();
    await core.boxes.stop(old.id);
    runs = [{ id: "fresh-run", projectId: old.projectId, status: "running" }];
    const fresh = await h.core.boxes.create({
      targetDir: h.dir("fresh"),
      layout: "root",
      start: true,
    });
    const prepared = await service.prepare();
    expect(prepared.boxes.map((box) => box.id)).toEqual([old.id, fresh.id]);
    expect(prepared.runs.map((run) => run.run_id)).toEqual(["old-run", "fresh-run"]);
    const report = await new UpgradeService({ ...options, build: async () => "latest" }).start();
    expect(report.boxes.every((box) => box.restored)).toBe(true);
    expect((await core.boxes.get(old.id)).status).toBe("running");
    expect(resumed).toEqual(["old-run", "fresh-run"]);
  });

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

  it("drops a deleted box and a deleted run from the record and reports them as gone", async () => {
    const h = makeHarness();
    const kept = await h.core.boxes.create({
      targetDir: h.dir("kept"),
      layout: "root",
      start: true,
    });
    const deleted = await h.core.boxes.create({
      targetDir: h.dir("deleted"),
      layout: "root",
      start: true,
    });
    const core = apiCoreOf(h.core, {} as Docker);
    const runs = [{ id: "deleted-run", projectId: kept.projectId, status: "running" }];
    let builds = 0;
    const service = new UpgradeService({
      core,
      recordFile: path.join(h.home, "gone.json"),
      build: async () => {
        builds += 1;
        if (builds === 1) throw new Error("build failed");
        return "latest";
      },
      runs: () => runs,
      resume: async () => {
        throw Object.assign(new Error("No run deleted-run."), { code: "run_not_found" });
      },
    });
    await service.start();
    await core.boxes.stop(deleted.id);
    await core.boxes.remove(deleted.id, { removeWorktree: false });
    const report = await service.start();
    expect(report.boxes.find((box) => box.id === deleted.id)).toMatchObject({
      restored: false,
      gone: true,
    });
    expect(report.boxes.find((box) => box.id === kept.id)).toMatchObject({ restored: true });
    expect(report.runs[0]).toMatchObject({ run_id: "deleted-run", restored: false, gone: true });
    expect(service.hasOpenWork).toBe(false);
  });

  it("doesn't bring back a box the owner stopped after a failed build", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root", start: true });
    const core = apiCoreOf(h.core, {} as Docker);
    const options = {
      core,
      recordFile: path.join(h.home, "stopped.json"),
      runs: () => [],
      resume: async () => {},
    };
    await new UpgradeService({
      ...options,
      build: async () => {
        throw new Error("build failed");
      },
    }).start();
    const upgrade = new UpgradeService({ ...options, build: async () => "latest" });
    const base = await createHarness();
    const api = await createApiServer({ ...base.deps, core, upgrade });
    const response = await api.app.inject({
      method: "POST",
      url: `/api/v1/boxes/${box.id}/stop`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect((await upgrade.prepare()).boxes).toEqual([]);
    const report = await upgrade.start();
    expect(report.boxes).toEqual([]);
    expect((await core.boxes.get(box.id)).status).not.toBe("running");
  });
});

describe("upgrade image build log", () => {
  it("saves the build output and names its last line and the log in the error", async () => {
    const { mkdtempSync, readFileSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { imageBuildFailureMessage, saveImageBuildLog } =
      await import("../../src/setup/upgrade.js");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "aio-upgrade-")), "logs", "build.log");
    const output = "#19 DONE 40.1s\nError response from daemon: No such image: sha256:abc\n\n";
    expect(saveImageBuildLog(file, output)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(output);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(imageBuildFailureMessage(output, file, "fallback")).toBe(
      `The image build failed: Error response from daemon: No such image: sha256:abc. The full build log is in ${file}.`,
    );
    expect(imageBuildFailureMessage("", null, "The command exited with code 1.")).toBe(
      "The command exited with code 1.",
    );
  });
});

describe("upgrade with a failed image build", () => {
  it("reports the build error once and leaves the boxes as they were", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      conversationName: "Working",
      start: true,
    });
    const core = apiCoreOf(h.core, {} as Docker);
    const options = {
      core,
      recordFile: path.join(h.home, "upgrade.json"),
      build: async (): Promise<"latest"> => {
        throw new Error("The image build failed: No such image. The full build log is in /x.log.");
      },
      runs: () => [],
      resume: async () => {},
    };
    await new UpgradeService(options).prepare();
    const report = await new UpgradeService(options).start();
    expect(report.image).toBe("failed");
    expect(report.error).toBe(
      "The image build failed: No such image. The full build log is in /x.log.",
    );
    expect(report.boxes).toEqual([
      {
        id: box.id,
        name: "Working",
        restored: false,
        reason: "Not restored, because the image build failed.",
      },
    ]);
  });
});
