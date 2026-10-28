import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { demuxBuffer } from "../../src/docker/dockerode.js";
import {
  ImageVersions,
  VERSION_PROBE_COMMAND,
  imageBuildOptions,
  imageStatus,
  parseVersionProbe,
} from "../../src/docker/image.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import { CpuTracker } from "../../src/docker/stats.js";

describe("CpuTracker", () => {
  it("computes docker's CPU formula across two samples and memory without cache", () => {
    const t = new CpuTracker();
    const base = { onlineCpus: 4, memUsage: 500, memInactiveFile: 100, memLimit: 1000 };
    expect(t.update("c", { ...base, cpuTotalUsage: 100, systemCpuUsage: 1000 })).toEqual({
      cpuPercent: null,
      memBytes: 400,
      memLimitBytes: 1000,
    });
    expect(
      t.update("c", { ...base, cpuTotalUsage: 200, systemCpuUsage: 2000 }).cpuPercent,
    ).toBeCloseTo(40);
    expect(
      t.update("c", { ...base, cpuTotalUsage: 150, systemCpuUsage: 3000 }).cpuPercent,
    ).toBeNull();
    t.forget("c");
    expect(
      t.update("c", { ...base, cpuTotalUsage: 300, systemCpuUsage: 4000 }).cpuPercent,
    ).toBeNull();
    expect(
      t.update("d", {
        ...base,
        memUsage: 50,
        memInactiveFile: 100,
        cpuTotalUsage: 0,
        systemCpuUsage: 0,
      }).memBytes,
    ).toBe(50);
  });
});

describe("image helpers", () => {
  it("builds the three kinds like the 3.3.5 setup wizard", () => {
    const now = new Date("2026-10-28T09:00:00Z");
    const o = imageBuildOptions({
      kind: "rebuild",
      context: "/repo/image",
      tag: "claude-code",
      user: "tester",
      now,
    });
    expect(o).toEqual({
      context: "/repo/image",
      tag: "claude-code",
      buildArgs: { USER_NAME: "tester" },
      noCache: true,
      pull: true,
    });
    expect(
      imageBuildOptions({ kind: "packages", context: ".", tag: "t", user: "u", now }).buildArgs,
    ).toEqual({ USER_NAME: "u", CACHEBUST_PACKAGES: "1793178000" });
    expect(
      imageBuildOptions({ kind: "claude-code", context: ".", tag: "t", user: "u", now }),
    ).toMatchObject({ buildArgs: { CACHEBUST: "1793178000" }, noCache: false, pull: false });
  });

  it("parses the version probe", () => {
    expect(parseVersionProbe("engineVersion=4.0.0\nclaude=2.1.310\ncodex=\nbogus=1\n")).toEqual({
      engineVersion: "4.0.0",
      claude: "2.1.310",
    });
    expect(VERSION_PROBE_COMMAND).toContain("/etc/agentbox-engine-version");
  });

  it("reads versions from labels first, then the files, cached per image id", async () => {
    const docker = new MemoryDocker();
    docker.addImage("claude-code", { "agentbox.engine-version": "4.0.0" });
    docker.runOnceAnswers.set("agentbox-engine-version", {
      exitCode: 0,
      stdout: "engineVersion=3.9\nclaude=2.1.310\n",
      stderr: "",
    });
    const v = new ImageVersions(docker);
    expect((await v.read("claude-code"))?.versions).toEqual({
      engineVersion: "4.0.0",
      claude: "2.1.310",
    });
    await v.read("claude-code");
    expect(docker.callsOf("runOnce")).toHaveLength(1);
    expect(await v.read("missing")).toBeNull();
    const status = await imageStatus(v, docker, "claude-code", "4.0.0");
    expect(status).toMatchObject({
      exists: true,
      engineVersion: "4.0.0",
      engineMatches: true,
      cliVersions: { claude: "2.1.310", codex: null },
    });
    expect(await imageStatus(v, docker, "missing", "4.0.0")).toMatchObject({
      exists: false,
      imageId: null,
      engineMatches: false,
    });
  });
});

describe("demuxBuffer", () => {
  it("splits multiplexed frames", async () => {
    const frame = (type: number, text: string) => {
      const payload = Buffer.from(text);
      const h = Buffer.alloc(8);
      h[0] = type;
      h.writeUInt32BE(payload.length, 4);
      return Buffer.concat([h, payload]);
    };
    const out = new PassThrough();
    const err = new PassThrough();
    const o: Buffer[] = [];
    const e: Buffer[] = [];
    out.on("data", (c: Buffer) => o.push(c));
    err.on("data", (c: Buffer) => e.push(c));
    demuxBuffer(Buffer.concat([frame(1, "hello "), frame(2, "oops"), frame(1, "world")]), out, err);
    await new Promise((r) => setImmediate(r));
    expect(Buffer.concat(o).toString()).toBe("hello world");
    expect(Buffer.concat(e).toString()).toBe("oops");
  });
});
