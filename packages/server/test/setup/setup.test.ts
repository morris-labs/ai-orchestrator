import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { tempDir } from "../tmp.js";

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
  home = tempDir("agentbox-setup-");
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
  opRead?: (ref: string) => Promise<string>;
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
    read: overrides.opRead ?? (async () => ""),
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
    imageContext: overrides.imageContext ?? "/opt/agentbox/image",
    serviceInstalled: async () => overrides.installed ?? false,
    installService: async (io) => {
      installs.push("install");
      io.write("installed\r\n");
    },
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
      "sudo",
      "service",
    ]);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(byId(checks).ssh_client?.message).toBe("OpenSSH_9.6p1");
    expect(byId(checks).image?.message).toContain("sha256:abc");
  });

  it("reports sudo as off without a reference, and checks a reference without showing it", async () => {
    const off = byId(await make({}).svc.checks()).sudo;
    expect(off).toMatchObject({ status: "ok", fixable: false });
    expect(off?.message).toContain("sudo is off in containers");

    const ref = "op://SYNTHETIC/sudo/password";
    const value = "SYNTHETIC_SUDO_PASSWORD";
    const reads: string[] = [];
    const on = byId(
      await make({
        settings: { sudoPasswordRef: ref },
        opRead: async (r) => {
          reads.push(r);
          return value;
        },
      }).svc.checks(),
    ).sudo;
    expect(reads).toEqual([ref]);
    expect(on).toMatchObject({ status: "ok" });
    expect(on?.message).toContain(ref);
    expect(on?.message).not.toContain(value);

    const empty = byId(await make({ settings: { sudoPasswordRef: ref } }).svc.checks()).sudo;
    expect(empty?.status).toBe("fail");
    const locked = byId(
      await make({
        settings: { sudoPasswordRef: ref },
        op: { installed: true, version: "2.30.0", signedIn: false, mode: "desktop" },
      }).svc.checks(),
    ).sudo;
    expect(locked).toMatchObject({ status: "fail" });
    expect(locked?.message).toContain("not signed in");
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
    expect(status.checks).toHaveLength(9);
  });
});

describe("SetupService image builds and fixes", () => {
  it.each([
    ["rebuild", ["--no-cache"]],
    ["packages", ["--update-packages"]],
    ["claude-code", ["--update-cli"]],
  ] as const)("runs the build script for %s", (kind, variant) => {
    const { svc } = make({});
    expect(svc.buildArgv(kind)).toEqual([
      "/opt/agentbox/scripts/build-image.sh",
      "--tag",
      "claude-code",
      ...variant,
    ]);
  });

  /** A build context that holds a Dockerfile, with the build script beside it. */
  async function context(opts: { script?: boolean; name?: string } = {}): Promise<string> {
    const dir = join(home, opts.name ?? "image");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Dockerfile"), "FROM ubuntu\n");
    if (opts.script ?? true) {
      await mkdir(join(home, "scripts"), { recursive: true });
      await writeFile(join(home, "scripts", "build-image.sh"), "#!/bin/sh\n", { mode: 0o755 });
    }
    return dir;
  }

  it("refuses an image build whose context has no Dockerfile", async () => {
    const { svc, runner } = make({ imageContext: join(home, "empty") });
    expect(() => svc.buildImage("rebuild")).toThrow(/no Dockerfile/);
    expect(runner.spawned).toHaveLength(0);
  });

  it("refuses an image build without the build script beside the context", async () => {
    const { svc, runner } = make({ imageContext: await context({ script: false }) });
    expect(() => svc.buildImage("rebuild")).toThrow(
      expect.objectContaining({
        code: "image_missing",
        message: expect.stringMatching(/build-image\.sh/),
      }),
    );
    expect(runner.spawned).toHaveLength(0);
  });

  it("refuses a context that isn't named image, since the script builds ../image", async () => {
    const { svc } = make({ imageContext: await context({ name: "other" }) });
    expect(() => svc.buildImage("rebuild")).toThrow(/must be named image/);
  });

  it("runs the build script as a job under a pty with plain progress", async () => {
    const { svc, runner, jobs } = make({
      settings: { engineImage: "my-image" },
      imageContext: await context(),
    });
    const job = svc.buildImage("rebuild");
    expect(job.kind).toBe("image_build");
    expect(job.command).toBe(
      `${join(home, "scripts", "build-image.sh")} --tag my-image --no-cache`,
    );
    await waitFor(() => runner.spawned.length === 1);
    expect(runner.spawned[0]?.argv).toEqual([
      join(home, "scripts", "build-image.sh"),
      "--tag",
      "my-image",
      "--no-cache",
    ]);
    expect(runner.spawned[0]?.options.pty).toBe(true);
    expect(runner.spawned[0]?.options.env?.BUILDKIT_PROGRESS).toBe("plain");
    runner.spawned[0]!.exit(1);
    await waitFor(() => jobs.get(job.id)?.status === "failed");
  });

  it("builds with every versions.env pin when run from the installed layout", async () => {
    // Mimics /usr/share/agentbox with the real script, so the job's argv and
    // the script agree on the options and the script passes the pins.
    const repo = fileURLToPath(new URL("../../../../", import.meta.url));
    const root = join(home, "share");
    const img = join(root, "image");
    await mkdir(join(img, "keeper"), { recursive: true });
    await mkdir(join(img, "dist"), { recursive: true });
    await mkdir(join(root, "scripts", "lib"), { recursive: true });
    await copyFile(
      join(repo, "scripts", "build-image.sh"),
      join(root, "scripts", "build-image.sh"),
    );
    await chmod(join(root, "scripts", "build-image.sh"), 0o755);
    await copyFile(
      join(repo, "scripts", "lib", "common.sh"),
      join(root, "scripts", "lib", "common.sh"),
    );
    const versions = await readFile(join(repo, "image", "versions.env"), "utf8");
    await writeFile(join(img, "versions.env"), versions);
    await writeFile(join(img, "Dockerfile"), "FROM ubuntu\n");
    await writeFile(join(img, "keeper", "keeper.sh"), "");
    await writeFile(join(img, "keeper", "start-session.sh"), "");
    const engine = /^AGENTBOX_ENGINE_VERSION=(.+)$/m.exec(versions)?.[1];
    await writeFile(join(img, "dist", `agentbox-engine-${engine}.tgz`), "");

    const { svc } = make({ imageContext: img, settings: { engineImage: "claude-code:v4test" } });
    const argv = svc.buildArgv("packages");
    const out = execFileSync(argv[0] as string, [...argv.slice(1), "--print"], {
      encoding: "utf8",
    });
    expect(out).toContain("docker build -t claude-code:v4test");
    expect(out).toMatch(/--build-arg CACHEBUST_PACKAGES=\d+/);
    for (const line of versions.split("\n").filter((l) => /^[A-Z]/.test(l))) {
      expect(out).toContain(`--build-arg ${line}`);
    }
    expect(out).toContain("NVM_VERSION=");
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

  it("completes an existing key instead of running ssh-keygen over it", async () => {
    await mkdir(join(home, ".ssh"));
    const key = join(home, ".ssh", "id_ed25519");
    await writeFile(key, "SYNTHETIC private key\n", { mode: 0o600 });
    const runner = new FakeRunner((argv) =>
      argv[1] === "-y" ? { stdout: "ssh-ed25519 SYNTHETICKEY claude-box\n" } : {},
    );
    const { svc, jobs } = make({ runner });
    const job = svc.fix("ssh_key");
    await waitFor(() => jobs.get(job.id)?.status !== "running");
    expect(jobs.get(job.id)?.status).toBe("finished");
    expect(runner.spawned).toHaveLength(0);
    expect(runner.runs.map((r) => r.argv)).toEqual([["ssh-keygen", "-y", "-P", "", "-f", key]]);
    expect(await readFile(`${key}.pub`, "utf8")).toBe("ssh-ed25519 SYNTHETICKEY claude-box\n");
    expect(await readFile(key, "utf8")).toBe("SYNTHETIC private key\n");

    // A complete pair is left alone.
    const again = svc.fix("ssh_key");
    await waitFor(() => jobs.get(again.id)?.status !== "running");
    expect(jobs.get(again.id)?.status).toBe("finished");
    expect(runner.runs).toHaveLength(1);
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
