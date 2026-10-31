import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALLED_WEB_ROOT, defaultStaticDir } from "../../src/api/static-dirs.js";
import { demuxBuffer } from "../../src/docker/dockerode.js";
import {
  ImageVersions,
  VERSION_PROBE_COMMAND,
  INSTALLED_IMAGE_CONTEXT,
  defaultImageContext,
  imageBuildScript,
  imageBuildScriptArgs,
  imageStatus,
  parseVersionProbe,
  versionProbeCommand,
} from "../../src/docker/image.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import { CpuTracker } from "../../src/docker/stats.js";
import { tempDir } from "../tmp.js";

describe("CpuTracker", () => {
  it("drops the baselines of containers that are gone", () => {
    const t = new CpuTracker();
    const s = {
      onlineCpus: 1,
      memUsage: 1,
      memInactiveFile: 0,
      memLimit: 1,
      cpuTotalUsage: 1,
      systemCpuUsage: 1,
    };
    t.update("a", s);
    t.update("b", s);
    t.retain(["b"]);
    expect(t.size).toBe(1);
    expect(t.update("a", { ...s, cpuTotalUsage: 2, systemCpuUsage: 2 }).cpuPercent).toBeNull();
    expect(t.update("b", { ...s, cpuTotalUsage: 2, systemCpuUsage: 2 }).cpuPercent).not.toBeNull();
  });

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
  it("maps the three kinds to build script options like the 3.3.5 setup wizard", () => {
    expect(imageBuildScriptArgs("rebuild")).toEqual(["--no-cache"]);
    expect(imageBuildScriptArgs("packages")).toEqual(["--update-packages"]);
    expect(imageBuildScriptArgs("claude-code")).toEqual(["--update-cli"]);
  });

  it("finds the build script beside the context, in a checkout and installed", () => {
    expect(imageBuildScript("/repo/image")).toBe("/repo/scripts/build-image.sh");
    expect(imageBuildScript("/repo/image/")).toBe("/repo/scripts/build-image.sh");
    expect(imageBuildScript(INSTALLED_IMAGE_CONTEXT)).toBe(
      "/usr/share/agentbox/scripts/build-image.sh",
    );
  });

  it("defaults the context to the checkout, else the installed package", () => {
    const has = (files: string[]) => (p: string) => files.includes(p);
    expect(defaultImageContext("/repo", has(["/repo/image/Dockerfile"]))).toBe("/repo/image");
    expect(defaultImageContext("/usr/lib", has(["/usr/share/agentbox/image/Dockerfile"]))).toBe(
      "/usr/share/agentbox/image",
    );
    expect(defaultImageContext("/repo", has([]))).toBe("/repo/image");
  });

  it("defaults the web bundles to the checkout, else the installed package", () => {
    const has = (files: string[]) => (p: string) => files.includes(p);
    expect(
      defaultStaticDir("/repo", "boxes", has(["/repo/apps/boxes/dist/renderer/index.html"])),
    ).toBe("/repo/apps/boxes/dist/renderer");
    expect(
      defaultStaticDir("/usr/lib", "review", has([`${INSTALLED_WEB_ROOT}/review/index.html`])),
    ).toBe("/usr/share/agentbox/web/review");
    expect(defaultStaticDir("/repo", "boxes", has([]))).toBe("/repo/apps/boxes/dist/renderer");
  });

  it("parses the version probe", () => {
    expect(parseVersionProbe("engineVersion=4.0.0\nclaude=2.1.310\ncodex=\nbogus=1\n")).toEqual({
      engineVersion: "4.0.0",
      claude: "2.1.310",
    });
    expect(VERSION_PROBE_COMMAND).toContain("/etc/agentbox-engine-version");
  });

  describe("under sh", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    it("reports every CLI, from its file or else its npm package", () => {
      const dir = tempDir("agentbox-probe-");
      dirs.push(dir);
      // A global npm root with all three CLIs, and an `npm` that prints it.
      const root = path.join(dir, "lib", "node_modules");
      for (const [pkg, version] of [
        ["@anthropic-ai/claude-code", "9.9.9"],
        ["@openai/codex", "0.165.0"],
        ["@github/copilot", "1.0.105"],
      ] as const) {
        fs.mkdirSync(path.join(root, pkg), { recursive: true });
        fs.writeFileSync(path.join(root, pkg, "package.json"), JSON.stringify({ version }));
      }
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho '${root}'\n`, { mode: 0o755 });
      // Only the engine and Claude Code have version files, as in the first 4.0 image.
      const file = (name: string, content?: string) => {
        const f = path.join(dir, name);
        if (content !== undefined) fs.writeFileSync(f, content);
        return f;
      };
      const command = versionProbeCommand({
        engineVersion: file("engine", "4.0.0-dev\n"),
        claude: file("claude", "2.1.312\n"),
        codex: file("codex"),
        copilot: file("copilot"),
      });
      const r = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
      });
      expect(r.status).toBe(0);
      expect(parseVersionProbe(r.stdout)).toEqual({
        engineVersion: "4.0.0-dev",
        claude: "2.1.312",
        codex: "0.165.0",
        copilot: "1.0.105",
      });
    });

    it("leaves a CLI out when neither its file nor its package exists", () => {
      const dir = tempDir("agentbox-probe-");
      dirs.push(dir);
      const missing = path.join(dir, "missing");
      // An empty npm root, so the CLIs installed on this host stay out of it.
      const root = path.join(dir, "lib", "node_modules");
      fs.mkdirSync(root, { recursive: true });
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho '${root}'\n`, { mode: 0o755 });
      const r = spawnSync(
        "/bin/sh",
        [
          "-c",
          versionProbeCommand({
            engineVersion: missing,
            claude: missing,
            codex: missing,
            copilot: missing,
          }),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
        },
      );
      expect(r.status).toBe(0);
      expect(parseVersionProbe(r.stdout)).toEqual({});
    });
  });

  it("reads codex and copilot through the probe when the labels lack them", async () => {
    const docker = new MemoryDocker();
    docker.addImage("claude-code", {});
    docker.runOnceAnswers.set("agentbox-engine-version", {
      exitCode: 0,
      stdout: "engineVersion=4.0.0\nclaude=2.1.312\ncodex=0.165.0\ncopilot=1.0.105\n",
      stderr: "",
    });
    const status = await imageStatus(new ImageVersions(docker), docker, "claude-code", "4.0.0");
    expect(status.cliVersions).toEqual({ claude: "2.1.312", codex: "0.165.0", copilot: "1.0.105" });
    const call = docker.callsOf("runOnce")[0]?.args[0] as { entrypoint: string[]; cmd: string[] };
    expect(call.entrypoint).toEqual(["sh"]);
    expect(call.cmd[1]).toContain("@openai/codex/package.json");
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
