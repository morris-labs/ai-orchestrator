// SetupService branches that depend on the host operating system, with the
// host injected. The Windows paths are strings only: the build context and
// the home directory are real temporary directories.
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig, type SetupCheck } from "@aio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Core } from "../../src/api/core-interface.js";
import { JobManager } from "../../src/jobs/jobs.js";
import { hostPlatform, type HostPlatform } from "../../src/platform/host.js";
import type { OpClient } from "../../src/secrets/op.js";
import { SetupService } from "../../src/setup/setup-service.js";
import { FakeRunner, waitFor } from "./fake-runner.js";
import { tempDir } from "../tmp.js";

let home: string;
beforeEach(() => {
  home = tempDir("aio-setup-platform-");
});
afterEach(async () => rm(home, { recursive: true, force: true }));

function make(platform: HostPlatform, imageContext = "/opt/ai-orchestrator/image") {
  const runner = new FakeRunner((argv) => (argv[0] === "ssh" ? { stderr: "OpenSSH_9.6p1\n" } : {}));
  const op: OpClient = {
    status: async () => ({ installed: false, version: null, signedIn: false, mode: "none" }),
    read: async () => "",
    listItems: async () => [],
  };
  const core = {
    docker: { ping: async () => false },
    image: { status: async () => ({ exists: false, name: "aio-agent" }) },
    settings: { get: () => defaultConfig() },
  } as unknown as Pick<Core, "docker" | "image" | "settings">;
  const svc = new SetupService({
    core,
    jobs: new JobManager(),
    runner,
    op,
    home,
    imageContext,
    serviceInstalled: async () => false,
    installService: async () => undefined,
    platform,
  });
  return { svc, runner };
}

async function context(): Promise<string> {
  const dir = join(home, "image");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Dockerfile"), "FROM ubuntu\n");
  await mkdir(join(home, "scripts"), { recursive: true });
  await writeFile(join(home, "scripts", "build-image.sh"), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

const byId = (checks: SetupCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("SetupService on each host", () => {
  it("checks SSH modes on macOS like on Linux", async () => {
    await mkdir(join(home, ".ssh"));
    await chmod(join(home, ".ssh"), 0o755);
    const { svc } = make(hostPlatform("darwin", { home }));
    expect(byId(await svc.checks()).ssh_permissions?.status).toBe("warn");
  });

  it("skips SSH mode checks and fixes on Windows, which has ACLs instead", async () => {
    await mkdir(join(home, ".ssh"));
    await chmod(join(home, ".ssh"), 0o755);
    const { svc } = make(hostPlatform("win32", { home }));
    const check = byId(await svc.checks()).ssh_permissions;
    expect(check).toMatchObject({ status: "ok", fixable: false });
    expect(check?.message).toMatch(/access control list/);
    expect(() => svc.fix("ssh_permissions")).toThrow(/no file modes/);
  });

  it("words the Docker and ssh fixes for the host", () => {
    expect(() => make(hostPlatform("darwin", { home })).svc.fix("docker")).toThrow(
      /Docker Desktop/,
    );
    expect(() => make(hostPlatform("win32", { home })).svc.fix("ssh_client")).toThrow(
      /OpenSSH Client/,
    );
    expect(() => make(hostPlatform("linux", { home })).svc.fix("ssh_client")).toThrow(
      /sudo apt install openssh-client/,
    );
  });

  it("runs the image build script directly on macOS and names the image user", async () => {
    const { svc, runner } = make(
      hostPlatform("darwin", { home, env: { USER: "alex" } }),
      await context(),
    );
    svc.buildImage("rebuild");
    await waitFor(() => runner.spawned.length === 1);
    expect(runner.spawned[0]?.argv).toEqual([
      join(home, "scripts", "build-image.sh"),
      "--tag",
      "aio-agent",
      "--no-cache",
      "--user",
      "alex",
    ]);
  });

  it("runs the image build through Git Bash on Windows and names the image user", async () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const p = hostPlatform("win32", {
      home,
      env: { USERNAME: "Alex" },
      exists: (f) => f === bash,
    });
    const { svc, runner } = make(p, await context());
    const job = svc.buildImage("packages");
    expect(job.command).toContain("--user alex");
    await waitFor(() => runner.spawned.length === 1);
    expect(runner.spawned[0]?.argv).toEqual([
      bash,
      join(home, "scripts", "build-image.sh"),
      "--tag",
      "aio-agent",
      "--update-packages",
      "--user",
      "alex",
    ]);
  });

  it("refuses the image build on Windows without a bash", async () => {
    const { svc } = make(hostPlatform("win32", { home }), await context());
    expect(() => svc.buildImage("rebuild")).toThrow(/Git for Windows/);
  });
});
