import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfig,
  type GlobalSettings,
  type ImageStatus,
  type OpStatus,
  type SetupCheck,
} from "@agentbox/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Core } from "../../src/api/core-interface.js";
import { JobManager } from "../../src/jobs/jobs.js";
import type { OpClient } from "../../src/secrets/op.js";
import { SetupService } from "../../src/setup/setup-service.js";
import { FakeRunner, waitFor } from "./fake-runner.js";

const image: ImageStatus = {
  name: "claude-code",
  exists: true,
  imageId: "sha256:abc",
  createdAt: "2026-10-01T00:00:00Z",
  engineVersion: "4.0.0",
  expectedEngineVersion: "4.0.0",
  engineMatches: true,
  cliVersions: { claude: "2.1.300", codex: null, copilot: null },
};

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agentbox-setup-"));
});
afterEach(async () => rm(home, { recursive: true, force: true }));

function make(overrides: {
  ping?: boolean;
  image?: Partial<ImageStatus> | Error;
  op?: OpStatus;
  installed?: boolean;
  runner?: FakeRunner;
  settings?: Partial<GlobalSettings>;
  imageContext?: string;
}) {
  const settings: GlobalSettings = { ...defaultConfig(), ...overrides.settings };
  const runner =
    overrides.runner ??
    new FakeRunner((argv) => (argv[0] === "ssh" ? { stderr: "OpenSSH_9.6p1\n" } : {}));
  const jobs = new JobManager();
  const installs: string[] = [];
  const op: OpClient = {
    status: async () =>
      overrides.op ?? { installed: true, version: "2.30.0", signedIn: true, mode: "desktop" },
    read: async () => "",
  };
  const core = {
    docker: { ping: async () => overrides.ping ?? true },
    image: {
      status: async () => {
        if (overrides.image instanceof Error) throw overrides.image;
        return { ...image, ...overrides.image };
      },
    },
    settings: { get: () => settings },
  } as unknown as Pick<Core, "docker" | "image" | "settings">;
  const svc = new SetupService({
    core,
    jobs,
    runner,
    op,
    home,
    user: "me",
    imageContext: overrides.imageContext ?? "/opt/agentbox/image",
    serviceInstalled: async () => overrides.installed ?? false,
    installService: async (io) => {
      installs.push("install");
      io.write("installed\r\n");
    },
    now: () => new Date("2026-10-28T00:00:00Z"),
  });
  return { svc, runner, jobs, installs };
}

const byId = (checks: SetupCheck[]): Record<string, SetupCheck> =>
  Object.fromEntries(checks.map((c) => [c.id, c]));

describe("SetupService checks", () => {
  it("reports every check", async () => {
    await mkdir(join(home, ".ssh"), { mode: 0o700 });
    await writeFile(join(home, ".ssh", "id_ed25519"), "k", { mode: 0o600 });
    await writeFile(join(home, ".ssh", "id_ed25519.pub"), "k");
    await chmod(join(home, ".ssh"), 0o700);
    const { svc } = make({ installed: true });
    const checks = await svc.checks();
    expect(checks.map((c) => c.id)).toEqual([
      "docker",
      "image",
      "engine",
      "ssh_client",
      "ssh_key",
      "ssh_permissions",
      "op",
      "service",
    ]);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(byId(checks).ssh_client?.message).toBe("OpenSSH_9.6p1");
    expect(byId(checks).image?.message).toContain("sha256:abc");
  });

  it("reports failures", async () => {
    await mkdir(join(home, ".ssh"));
    await chmod(join(home, ".ssh"), 0o755);
    await writeFile(join(home, ".ssh", "id_ed25519"), "k", { mode: 0o644 });
    await chmod(join(home, ".ssh", "id_ed25519"), 0o644);
    const runner = new FakeRunner(() => ({ code: null, failedToStart: true }));
    const { svc } = make({
      ping: false,
      image: { engineMatches: false, engineVersion: "3.9.0" },
      op: { installed: false, version: null, signedIn: false, mode: "none" },
      runner,
    });
    const c = byId(await svc.checks());
    expect(c.docker).toMatchObject({ status: "fail", fixable: false });
    expect(c.engine).toMatchObject({ status: "fail", fixable: true });
    expect(c.engine?.message).toContain("3.9.0");
    expect(c.ssh_client?.status).toBe("fail");
    expect(c.ssh_key?.status).toBe("warn");
    expect(c.ssh_permissions?.status).toBe("warn");
    expect(c.ssh_permissions?.message).toContain("755");
    expect(c.ssh_permissions?.message).toContain("644");
    expect(c.op?.status).toBe("warn");
    expect(c.service?.status).toBe("warn");
  });

  it("warns about the engine when the image is missing, and survives an image error", async () => {
    let c = byId(await make({ image: { exists: false } }).svc.checks());
    expect(c.image?.status).toBe("fail");
    expect(c.engine?.status).toBe("warn");
    c = byId(await make({ image: new Error("boom") }).svc.checks());
    expect(c.image?.status).toBe("fail");
  });

  it("builds the status", async () => {
    const { svc } = make({ settings: { setupCompleted: true, defaultTargetDir: "/work" } });
    const status = await svc.status();
    expect(status.completed).toBe(true);
    expect(status.defaultTargetDir).toBe("/work");
    expect(status.checks).toHaveLength(8);
  });
});

describe("SetupService image builds and fixes", () => {
  it.each([
    ["rebuild", ["--no-cache", "--pull"]],
    ["packages", ["--build-arg", "CACHEBUST_PACKAGES=1793145600"]],
    ["claude-code", ["--build-arg", "CACHEBUST=1793145600"]],
  ] as const)("builds the %s argv", (kind, variant) => {
    const { svc } = make({});
    expect(svc.buildArgv(kind)).toEqual([
      "docker",
      "build",
      "-t",
      "claude-code",
      ...variant,
      "--build-arg",
      "USER_NAME=me",
      "--progress=plain",
      "/opt/agentbox/image",
    ]);
  });

  /** A build context that holds a Dockerfile. */
  async function context(): Promise<string> {
    const dir = join(home, "image");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Dockerfile"), "FROM ubuntu\n");
    return dir;
  }

  it("refuses an image build whose context has no Dockerfile", async () => {
    const { svc, runner } = make({ imageContext: join(home, "empty") });
    expect(() => svc.buildImage("rebuild")).toThrow(/no Dockerfile/);
    expect(runner.spawned).toHaveLength(0);
  });

  it("runs an image build as a job under a pty", async () => {
    const { svc, runner, jobs } = make({
      settings: { engineImage: "my-image" },
      imageContext: await context(),
    });
    const job = svc.buildImage("rebuild");
    expect(job.kind).toBe("image_build");
    expect(job.command).toContain("docker build -t my-image --no-cache --pull");
    await waitFor(() => runner.spawned.length === 1);
    expect(runner.spawned[0]?.options.pty).toBe(true);
    runner.spawned[0]!.exit(1);
    await waitFor(() => jobs.get(job.id)?.status === "failed");
  });

  it("routes fixes", async () => {
    const { svc, runner, jobs, installs } = make({ imageContext: await context() });
    expect(svc.fix("engine").kind).toBe("image_build");
    const keygen = svc.fix("ssh_key");
    expect(keygen.kind).toBe("setup_fix");
    await waitFor(() => runner.spawned.length === 2);
    expect(runner.spawned[1]?.argv).toEqual([
      "ssh-keygen",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(home, ".ssh", "id_ed25519"),
      "-C",
      "claude-box",
    ]);
    const service = svc.fix("service");
    await waitFor(() => jobs.get(service.id)?.status === "finished");
    expect(installs).toEqual(["install"]);
    for (const id of ["docker", "ssh_client", "op"]) {
      expect(() => svc.fix(id)).toThrow(expect.objectContaining({ code: "conflict" }));
    }
    expect(() => svc.fix("nope")).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("fixes SSH permissions", async () => {
    await mkdir(join(home, ".ssh"));
    await chmod(join(home, ".ssh"), 0o755);
    await writeFile(join(home, ".ssh", "id_ed25519"), "k");
    await chmod(join(home, ".ssh", "id_ed25519"), 0o644);
    const { svc, jobs } = make({});
    const job = svc.fix("ssh_permissions");
    await waitFor(() => jobs.get(job.id)?.status !== "running");
    expect(jobs.get(job.id)?.status).toBe("finished");
    expect((await stat(join(home, ".ssh"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, ".ssh", "id_ed25519"))).mode & 0o777).toBe(0o600);
    expect(jobs.attach(job.id)!.backlog.toString()).toContain("mode 600");
    expect(await readFile(join(home, ".ssh", "id_ed25519"), "utf8")).toBe("k");
  });
});
