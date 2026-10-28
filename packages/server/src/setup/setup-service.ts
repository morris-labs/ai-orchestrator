// The setup checks behind the setup wizard, their fixes, and the image build
// jobs (inventory section 2.6).
import { existsSync } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Job, SetupCheck, SetupStatusSchema } from "@agentbox/contracts";
import type { z } from "zod";
import type { Core } from "../api/core-interface.js";
import { ApiFailure, toApiFailure } from "../api/errors.js";
import { processJob, type JobIO, type JobManager } from "../jobs/jobs.js";
import { commandLine, type ProcessRunner } from "../jobs/process.js";
import type { OpClient } from "../secrets/op.js";

export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export type ImageBuildKind = "rebuild" | "packages" | "claude-code";

export interface SetupServiceOptions {
  core: Pick<Core, "docker" | "image" | "settings">;
  jobs: JobManager;
  runner: ProcessRunner;
  op: OpClient;
  home: string;
  /** The host user name, passed to the image build as `USER_NAME`. */
  user: string;
  /** The directory that holds the image's Dockerfile. */
  imageContext: string;
  serviceInstalled: () => Promise<boolean>;
  installService: (io: JobIO) => Promise<void>;
  /** The build time stamp; seconds since the epoch. */
  now?: () => Date;
}

type CheckId = SetupCheck["id"];

async function modeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return null;
  }
}

const octal = (mode: number) => mode.toString(8).padStart(3, "0");

export class SetupService {
  constructor(private readonly opts: SetupServiceOptions) {}

  private identity(): string {
    return this.opts.core.settings.get().sshIdentity ?? join(this.opts.home, ".ssh", "id_ed25519");
  }

  async status(): Promise<SetupStatus> {
    const settings = this.opts.core.settings.get();
    return {
      completed: settings.setupCompleted,
      defaultTargetDir: settings.defaultTargetDir ?? null,
      checks: await this.checks(),
    };
  }

  async checks(): Promise<SetupCheck[]> {
    return Promise.all([
      this.guard("docker", () => this.checkDocker()),
      ...(await this.imageChecks()),
      this.guard("ssh_client", () => this.checkSshClient()),
      this.guard("ssh_key", () => this.checkSshKey()),
      this.guard("ssh_permissions", () => this.checkSshPermissions()),
      this.guard("op", () => this.checkOp()),
      this.guard("service", () => this.checkService()),
    ]);
  }

  /** Runs one check and turns an exception into a failed row. */
  private async guard(id: CheckId, run: () => Promise<SetupCheck>): Promise<SetupCheck> {
    try {
      return await run();
    } catch (err) {
      return { id, status: "fail", message: toApiFailure(err).message, fixable: false };
    }
  }

  private async checkDocker(): Promise<SetupCheck> {
    const ok = await this.opts.core.docker.ping();
    return ok
      ? { id: "docker", status: "ok", message: "Docker is reachable.", fixable: false }
      : {
          id: "docker",
          status: "fail",
          message:
            "Docker is not reachable. Start the Docker daemon and check that you can use it.",
          fixable: false,
        };
  }

  private async imageChecks(): Promise<Promise<SetupCheck>[]> {
    let status: Awaited<ReturnType<Core["image"]["status"]>>;
    try {
      status = await this.opts.core.image.status();
    } catch (err) {
      const message = toApiFailure(err).message;
      return [
        Promise.resolve({ id: "image", status: "fail", message, fixable: true }),
        Promise.resolve({ id: "engine", status: "warn", message, fixable: true }),
      ];
    }
    const image: SetupCheck = status.exists
      ? {
          id: "image",
          status: "ok",
          message: `Image ${status.name} is present (${status.imageId ?? "unknown id"}, built ${status.createdAt ?? "at an unknown time"}).`,
          fixable: true,
        }
      : {
          id: "image",
          status: "fail",
          message: `Image ${status.name} doesn't exist. Build it to create boxes.`,
          fixable: true,
        };
    let engine: SetupCheck;
    if (!status.exists) {
      engine = {
        id: "engine",
        status: "warn",
        message: "The engine version is unknown until the image is built.",
        fixable: true,
      };
    } else if (status.engineMatches) {
      engine = {
        id: "engine",
        status: "ok",
        message: `The image carries engine ${status.engineVersion ?? status.expectedEngineVersion}.`,
        fixable: true,
      };
    } else {
      engine = {
        id: "engine",
        status: "fail",
        message: `The image carries engine ${status.engineVersion ?? "of an unknown version"}, but this server needs ${status.expectedEngineVersion}. Rebuild the image.`,
        fixable: true,
      };
    }
    return [Promise.resolve(image), Promise.resolve(engine)];
  }

  private async checkSshClient(): Promise<SetupCheck> {
    const result = await this.opts.runner.run("ssh", ["-V"], { timeoutMs: 10_000 });
    if (result.failedToStart || result.code !== 0) {
      return {
        id: "ssh_client",
        status: "fail",
        message: "The ssh client is not installed. Install openssh-client to use SSH remotes.",
        fixable: false,
      };
    }
    const version = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
    return {
      id: "ssh_client",
      status: "ok",
      message: version || "ssh is installed.",
      fixable: false,
    };
  }

  private async checkSshKey(): Promise<SetupCheck> {
    const identity = this.identity();
    const [priv, pub] = await Promise.all([modeOf(identity), modeOf(`${identity}.pub`)]);
    if (priv !== null && pub !== null) {
      return {
        id: "ssh_key",
        status: "ok",
        message: `Key pair ${identity} exists.`,
        fixable: true,
      };
    }
    return {
      id: "ssh_key",
      status: "warn",
      message: `Key pair ${identity} doesn't exist. Generate one to use SSH remotes.`,
      fixable: true,
    };
  }

  private async checkSshPermissions(): Promise<SetupCheck> {
    const sshDir = join(this.opts.home, ".ssh");
    const identity = this.identity();
    const problems: string[] = [];
    const dirMode = await modeOf(sshDir);
    if (dirMode === null) {
      return {
        id: "ssh_permissions",
        status: "ok",
        message: `${sshDir} doesn't exist yet.`,
        fixable: false,
      };
    }
    if (dirMode !== 0o700) problems.push(`${sshDir} has mode ${octal(dirMode)}, not 700`);
    const keyMode = await modeOf(identity);
    if (keyMode !== null && keyMode !== 0o600) {
      problems.push(`${identity} has mode ${octal(keyMode)}, not 600`);
    }
    if (problems.length === 0) {
      return {
        id: "ssh_permissions",
        status: "ok",
        message: "SSH permissions are correct.",
        fixable: true,
      };
    }
    return {
      id: "ssh_permissions",
      status: "warn",
      message: `${problems.join("; ")}.`,
      fixable: true,
    };
  }

  private async checkOp(): Promise<SetupCheck> {
    const op = await this.opts.op.status();
    if (!op.installed) {
      return {
        id: "op",
        status: "warn",
        message: "The 1Password CLI (op) is not installed. You need it only for secret references.",
        fixable: false,
      };
    }
    if (!op.signedIn) {
      return {
        id: "op",
        status: "warn",
        message: `The 1Password CLI ${op.version ?? ""} is installed but not signed in.`.replace(
          "  ",
          " ",
        ),
        fixable: false,
      };
    }
    return {
      id: "op",
      status: "ok",
      message:
        `The 1Password CLI ${op.version ?? ""} is signed in (${op.mode === "service_account" ? "service account" : "desktop app"}).`.replace(
          "  ",
          " ",
        ),
      fixable: false,
    };
  }

  private async checkService(): Promise<SetupCheck> {
    return (await this.opts.serviceInstalled())
      ? {
          id: "service",
          status: "ok",
          message: "The agentbox-server user service is installed.",
          fixable: true,
        }
      : {
          id: "service",
          status: "warn",
          message:
            "The agentbox-server user service is not installed, so the server doesn't start at login.",
          fixable: true,
        };
  }

  /** Starts the job that fixes a check. */
  fix(checkId: string): Job {
    switch (checkId) {
      case "image":
      case "engine":
        return this.buildImage("rebuild");
      case "ssh_key": {
        const argv = [
          "ssh-keygen",
          "-t",
          "ed25519",
          "-N",
          "",
          "-f",
          this.identity(),
          "-C",
          "claude-box",
        ];
        return this.opts.jobs.start({ kind: "setup_fix", command: commandLine(argv) }, (io) =>
          processJob(io, this.opts.runner.spawn(argv[0] as string, argv.slice(1))),
        );
      }
      case "ssh_permissions": {
        const sshDir = join(this.opts.home, ".ssh");
        const identity = this.identity();
        return this.opts.jobs.start(
          { kind: "setup_fix", command: `chmod 700 ${sshDir} && chmod 600 ${identity}` },
          async (io) => {
            await chmod(sshDir, 0o700);
            io.write(`Set ${sshDir} to mode 700.\r\n`);
            if ((await modeOf(identity)) !== null) {
              await chmod(identity, 0o600);
              io.write(`Set ${identity} to mode 600.\r\n`);
            }
            return { exitCode: 0 };
          },
        );
      }
      case "service":
        return this.opts.jobs.start(
          { kind: "setup_fix", command: "agentbox-server install-service" },
          async (io) => {
            await this.opts.installService(io);
            return { exitCode: 0 };
          },
        );
      case "docker":
        throw new ApiFailure(
          "conflict",
          "Install Docker, start the daemon, and add your user to the docker group, then check again.",
        );
      case "ssh_client":
        throw new ApiFailure(
          "conflict",
          "Install the ssh client with sudo apt install openssh-client.",
        );
      case "op":
        throw new ApiFailure(
          "conflict",
          "Install the 1Password CLI and sign in with op signin, or set OP_SERVICE_ACCOUNT_TOKEN for the server.",
        );
      default:
        throw new ApiFailure("not_found", `There is no setup check named ${checkId}.`);
    }
  }

  /** The `docker build` argv for a build kind. */
  buildArgv(kind: ImageBuildKind): string[] {
    const epoch = String(Math.floor((this.opts.now?.() ?? new Date()).getTime() / 1000));
    const variant =
      kind === "rebuild"
        ? ["--no-cache", "--pull"]
        : kind === "packages"
          ? ["--build-arg", `CACHEBUST_PACKAGES=${epoch}`]
          : ["--build-arg", `CACHEBUST=${epoch}`];
    return [
      "docker",
      "build",
      "-t",
      this.opts.core.settings.get().engineImage,
      ...variant,
      "--build-arg",
      `USER_NAME=${this.opts.user}`,
      "--progress=plain",
      this.opts.imageContext,
    ];
  }

  /** Builds or updates the image as an `image_build` job. */
  buildImage(kind: ImageBuildKind): Job {
    if (!existsSync(join(this.opts.imageContext, "Dockerfile"))) {
      throw new ApiFailure(
        "image_missing",
        `The image build context ${this.opts.imageContext} has no Dockerfile. Set AGENTBOX_IMAGE_CONTEXT to the directory that holds the image's Dockerfile.`,
      );
    }
    const argv = this.buildArgv(kind);
    return this.opts.jobs.start({ kind: "image_build", command: commandLine(argv) }, (io) =>
      processJob(io, this.opts.runner.spawn(argv[0] as string, argv.slice(1), { pty: true })),
    );
  }
}
