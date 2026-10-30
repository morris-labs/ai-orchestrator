import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISK_SIZE_INTERVAL_MS,
  looksLikeEngineRestart,
  type BoxEndedEvent,
} from "../../src/boxes/monitor.js";
import { assertContractEvent, makeHarness } from "./harness.js";

describe("looksLikeEngineRestart", () => {
  it("follows the 3.3.5 rule", () => {
    expect(looksLikeEngineRestart(true, 1, 1)).toBe(true);
    expect(looksLikeEngineRestart(false, 1, 1)).toBe(false);
    expect(looksLikeEngineRestart(false, 2, 1)).toBe(true);
    expect(looksLikeEngineRestart(false, 4, 1)).toBe(false);
    expect(looksLikeEngineRestart(false, 4, 2)).toBe(true);
  });
});

describe("ContainerMonitor", () => {
  it("publishes container states and stats from the second sample on", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    h.events.length = 0;
    await h.core.monitor.poll({ sampleStats: true });
    expect(h.events.filter((e) => e.type === "container.stats")).toHaveLength(0);
    await h.core.monitor.poll({ sampleStats: true });
    const stats = h.events.filter((e) => e.type === "container.stats");
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      container: box.container,
      projectId: box.projectId,
      cpuPercent: 20,
      memBytes: 200 * 1024 * 1024,
      diskBytes: 1024,
    });
    for (const e of h.events) assertContractEvent(e);
    expect(h.core.monitor.statsFor(box.container)).toMatchObject({ cpuPercent: 20 });
    h.docker.expireIdle(box.container);
    await h.core.boxes.stop(box.id);
    h.docker.expireIdle(box.container);
    await h.core.monitor.poll();
    expect(h.events.filter((e) => e.type === "container.changed").at(-1)).toMatchObject({
      state: "removed",
    });
    expect(h.core.monitor.statsFor(box.container)).toBeNull();
  });

  it("measures a container's disk size only every interval", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    const id = h.docker.containers.get(box.container)!.id;
    const realNow = h.env.now;
    let offsetMs = 0;
    h.env.now = () => new Date(realNow().getTime() + offsetMs);
    const sized = () => h.docker.callsOf("inspectContainer").filter((c) => c.args[0] === id).length;
    for (let i = 0; i < 4; i += 1) await h.core.monitor.poll({ sampleStats: true });
    expect(sized()).toBe(1);
    expect(h.core.monitor.statsFor(box.container)?.diskBytes).toBe(1024);
    offsetMs = DISK_SIZE_INTERVAL_MS;
    h.docker.tick();
    for (const f of fs.readdirSync(path.join(h.home, ".claude-box/state"))) {
      const t = new Date(realNow().getTime() + offsetMs);
      fs.utimesSync(path.join(h.home, ".claude-box/state", f, "sessions"), t, t);
    }
    await h.core.monitor.poll({ sampleStats: true });
    expect(sized()).toBe(2);
  });

  it("doesn't report a box as ended when the host wakes from suspend", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    const ended: BoxEndedEvent[] = [];
    h.core.monitor.on("boxEnded", (e: BoxEndedEvent) => ended.push(e));
    await h.core.monitor.poll();
    // Suspend: the clock jumps, and the keeper's file is as old as the jump.
    const realNow = h.env.now;
    const jumpMs = 10 * 60 * 1000;
    h.env.now = () => new Date(realNow().getTime() + jumpMs);
    await h.core.monitor.poll();
    expect(ended).toEqual([]);
    expect(h.core.boxes.get(box.id).wasRunning).toBe(true);
    // The keeper rewrites its file a second later.
    h.docker.tick();
    const file = path.join(h.home, ".claude-box/state", box.container, "sessions");
    const t = new Date(realNow().getTime() + jumpMs);
    fs.utimesSync(file, t, t);
    await h.core.monitor.poll();
    expect(ended).toEqual([]);
    expect(h.core.boxes.status(h.core.boxes.get(box.id))).toBe("running");
    // A session that really ends after the wake is still reported.
    h.docker.endSession(box.container, box.session);
    await h.core.monitor.poll();
    expect(ended).toEqual([{ boxId: box.id, unexpected: true }]);
  });

  it("clears was_running when a session ends on its own and reports it", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    const ended: BoxEndedEvent[] = [];
    h.core.monitor.on("boxEnded", (e: BoxEndedEvent) => ended.push(e));
    await h.core.monitor.poll();
    h.docker.endSession(box.container, box.session);
    await h.core.monitor.poll();
    expect(ended).toEqual([{ boxId: box.id, unexpected: true }]);
    expect(h.core.boxes.get(box.id).wasRunning).toBe(false);
    expect(h.events.filter((e) => e.type === "box.changed").at(-1)).toMatchObject({
      boxId: box.id,
      status: "stopped",
    });
  });

  it("keeps was_running when most boxes drop at once", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const a = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const b = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    await h.core.monitor.poll();
    h.docker.containers.clear();
    fs.rmSync(path.join(h.home, ".claude-box/state"), { recursive: true });
    await h.core.monitor.poll();
    expect(h.core.boxes.get(a.id).wasRunning).toBe(true);
    expect(h.core.boxes.get(b.id).wasRunning).toBe(true);
  });

  it("reports no unexpected end for boxes a Docker restart dropped", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const a = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const b = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const ended: BoxEndedEvent[] = [];
    h.core.monitor.on("boxEnded", (e: BoxEndedEvent) => ended.push(e));
    await h.core.monitor.poll();
    h.docker.containers.clear();
    fs.rmSync(path.join(h.home, ".claude-box/state"), { recursive: true });
    await h.core.monitor.poll();
    expect(ended.sort((x, y) => (x.boxId < y.boxId ? -1 : 1))).toEqual(
      [a.id, b.id].sort().map((boxId) => ({ boxId, unexpected: false })),
    );
  });

  it("marks a requested stop as expected", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    const ended: BoxEndedEvent[] = [];
    h.core.monitor.on("boxEnded", (e: BoxEndedEvent) => ended.push(e));
    await h.core.monitor.poll();
    await h.core.boxes.stop(box.id);
    await h.core.monitor.poll();
    expect(ended).toEqual([{ boxId: box.id, unexpected: false }]);
  });

  it("survives an unreachable daemon and feeds the watcher", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    const sessions = path.join(h.home, ".claude-box/sessions", box.container);
    fs.writeFileSync(
      path.join(sessions, "11.json"),
      JSON.stringify({
        pid: 11,
        sessionId: box.sessionUuid,
        updatedAt: 1,
        name: "x",
        nameSource: "user",
      }),
    );
    await h.core.monitor.poll();
    fs.writeFileSync(
      path.join(sessions, "11.json"),
      JSON.stringify({
        pid: 11,
        sessionId: box.sessionUuid,
        updatedAt: 2,
        name: "Named live",
        nameSource: "user",
      }),
    );
    await h.core.monitor.poll();
    expect(h.core.boxes.get(box.id).conversationName).toBe("Named live");
    h.docker.available = false;
    await expect(h.core.monitor.poll()).resolves.toBeUndefined();
  });
});

describe("core", () => {
  it("imports 3.3.5 records once on start and closes cleanly", async () => {
    const h = makeHarness();
    const work = h.dir("work", "app");
    fs.mkdirSync(path.join(h.home, ".claude-box/known"), { recursive: true });
    fs.writeFileSync(
      path.join(h.home, ".claude-box/known/claude-agent-app"),
      `target_dir=${work}\nsession_uuid=\nconversation_name=app\nyolo=1\nwas_running=1\n`,
    );
    const first = await h.core.start({ pollMs: 0, watch: false });
    expect(first.imported?.boxes.imported).toEqual(["claude-agent-app"]);
    expect(h.core.boxes.get("claude-agent-app")).toMatchObject({
      targetDir: work,
      wasRunning: true,
      session: "claude-agent-app",
    });
    expect(h.core.legacyImport.needed()).toBe(false);
    const second = await h.core.start({ pollMs: 0, watch: false });
    expect(second.imported).toBeNull();
    const status = await h.core.image.status();
    expect(status).toMatchObject({ exists: true, engineMatches: true });
    h.core.close();
  });
});
