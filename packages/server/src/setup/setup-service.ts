// The setup checks behind the setup wizard, their fixes, and the image build
// jobs (inventory section 2.6).
import { existsSync } from "node:fs";
import { chmod, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Job, SetupCheck, SetupStatusSchema } from "@aio/contracts";
import type { z } from "zod";
import type { Core } from "../api/core-interface.js";
import { ApiError, toApiError } from "../api/errors.js";
import {
  imageBuildScript,
  imageBuildScriptArgs,
  noEngineMessage,
  type ImageBuildKind,
} from "../docker/image.js";
import { processJob, type JobIO, type JobManager, type JobOutcome } from "../jobs/jobs.js";
import { commandLine, type ProcessRunner } from "../jobs/process.js";
import {
  bashScriptArgv,
  currentPlatform,
  hasPosixModes,
  installHint,
  type HostPlatform,
} from "../platform/host.js";
import { containerUsername } from "../records/env.js";
import type { OpClient } from "../secrets/op.js";

export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export type { ImageBuildKind };

export interface SetupServiceOptions {
  core: Pick<Core, "docker" | "image" | "settings">;
  jobs: JobManager;
  runner: ProcessRunner;
  op: OpClient;
  home: string;
  /**
   * The directory that holds the image's Dockerfile, named `image`, with
   * `scripts/build-image.sh` beside it in the same parent directory.
   */
  imageContext: string;
  serviceInstalled: () => Promise<boolean>;
  installService: (io: JobIO) => Promise<void>;
  /** The host operating system. Default: the one the process runs on. */
  platform?: HostPlatform;
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
  private readonly platform: HostPlatform;

  constructor(private readonly opts: SetupServiceOptions) {
    this.platform = opts.platform ?? currentPlatform(opts.home);
  }

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
      this.guard("sudo", () => this.checkSudo()),
      this.guard("service", () => this.checkService()),
    ]);
  }

  /** Runs one check and turns an exception into a failed row. */
  private async guard(id: CheckId, run: () => Promise<SetupCheck>): Promise<SetupCheck> {
    try {
      return await run();
    } catch (err) {
      return { id, status: "fail", message: toApiError(err).message, fixable: false };
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
      const message = toApiError(err).message;
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
        message:
          status.engineVersion === null
            ? noEngineMessage(status.name)
            : `The image carries engine ${status.engineVersion}, but this server needs ${status.expectedEngineVersion}. Rebuild the image.`,
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
    if (!hasPosixModes(this.platform)) {
      // Windows reports every file as mode 666 or 444; the folder's ACL,
      // which inherits from the user profile, is what protects the key.
      return {
        id: "ssh_permissions",
        status: "ok",
        message: `Windows protects ${sshDir} with the user profile's access control list; aio doesn't check it.`,
        fixable: false,
      };
    }
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

  /**
   * Whether containers get sudo: off without a reference, and with one, on
   * only when the reference resolves. Never returns the value.
   */
  private async checkSudo(): Promise<SetupCheck> {
    const ref = this.opts.core.settings.get().sudoPasswordRef;
    if (ref === undefined) {
      return {
        id: "sudo",
        status: "ok",
        message:
          "sudo is off in containers because no sudo password reference is set. To allow sudo with a password, set a 1Password reference for it in the setup wizard.",
        fixable: false,
      };
    }
    const op = await this.opts.op.status();
    const problem = !op.installed
      ? "the 1Password CLI (op) is not installed"
      : !op.signedIn
        ? "the 1Password CLI is not signed in"
        : null;
    if (problem === null) {
      try {
        // Only whether it resolves to a usable value matters; the value is
        // dropped at once.
        const value = await this.opts.op.read(ref);
        if (value.length === 0 || /[\n\r]/.test(value)) {
          throw new ApiError(
            "secrets_unavailable",
            "The value is empty or has more than one line.",
          );
        }
      } catch (err) {
        return {
          id: "sudo",
          status: "fail",
          message: `The sudo password reference ${ref} doesn't resolve, so containers won't start: ${toApiError(err).message}`,
          fixable: false,
        };
      }
      return {
        id: "sudo",
        status: "ok",
        message: `sudo in containers asks for the password at ${ref}.`,
        fixable: false,
      };
    }
    return {
      id: "sudo",
      status: "fail",
      message: `The sudo password reference ${ref} can't be resolved because ${problem}, so containers won't start.`,
      fixable: false,
    };
  }

  private async checkService(): Promise<SetupCheck> {
    return (await this.opts.serviceInstalled())
      ? {
          id: "service",
          status: "ok",
          message: "The aio-server user service is installed.",
          fixable: true,
        }
      : {
          id: "service",
          status: "warn",
          message:
            "The aio-server user service is not installed, so the server doesn't start at login.",
          fixable: true,
        };
  }

  /**
   * Writes the public half of an existing private key when it is missing;
   * leaves a complete pair alone.
   */
  private async completeKeyPair(
    io: JobIO,
    identity: string,
    derive: string[],
  ): Promise<JobOutcome> {
    const pub = `${identity}.pub`;
    if (existsSync(pub)) {
      io.write(`Key pair ${identity} already exists; nothing to do.\r\n`);
      return { exitCode: 0, failed: false };
    }
    const r = await this.opts.runner.run(derive[0] as string, derive.slice(1), {
      timeoutMs: 15_000,
    });
    const key = r.stdout.trim();
    if (r.code !== 0 || key === "") {
      io.write(
        `Couldn't read ${identity}: ${(r.stderr || r.stdout).trim() || "ssh-keygen failed"}.\r\n` +
          "If the key has a passphrase, run ssh-keygen -y -f on it yourself.\r\n",
      );
      return { exitCode: r.code ?? 1, failed: true };
    }
    await writeFile(pub, `${key}\n`, { mode: 0o644, flag: "wx" });
    io.write(`Wrote ${pub} from the existing private key.\r\n`);
    return { exitCode: 0, failed: false };
  }

  /** Starts the job that fixes a check. */
  fix(checkId: string): Job {
    switch (checkId) {
      case "image":
      case "engine":
        return this.buildImage("rebuild");
      case "ssh_key": {
        const identity = this.identity();
        // ssh-keygen -f on an existing key stops at "Overwrite (y/n)?", and
        // a "y" destroys the key, so an existing key is only completed.
        if (existsSync(identity)) {
          const derive = ["ssh-keygen", "-y", "-P", "", "-f", identity];
          return this.opts.jobs.start(
            { kind: "setup_fix", command: `${commandLine(derive)} > ${identity}.pub` },
            (io) => this.completeKeyPair(io, identity, derive),
          );
        }
        const argv = ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", identity, "-C", "aio"];
        return this.opts.jobs.start({ kind: "setup_fix", command: commandLine(argv) }, (io) =>
          processJob(io, this.opts.runner.spawn(argv[0] as string, argv.slice(1))),
        );
      }
      case "ssh_permissions": {
        if (!hasPosixModes(this.platform)) {
          throw new ApiError(
            "conflict",
            "Windows has no file modes to fix; aio doesn't change ACLs.",
          );
        }
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
          { kind: "setup_fix", command: "aio-server install-service" },
          async (io) => {
            await this.opts.installService(io);
            return { exitCode: 0 };
          },
        );
      case "docker":
        throw new ApiError("conflict", installHint(this.platform, "docker"));
      case "ssh_client":
        throw new ApiError("conflict", installHint(this.platform, "ssh"));
      case "op":
        throw new ApiError(
          "conflict",
          "Install the 1Password CLI and sign in with op signin, or set OP_SERVICE_ACCOUNT_TOKEN for the server.",
        );
      case "sudo":
        throw new ApiError(
          "conflict",
          "Set the sudo password reference to an op:// reference that resolves, or clear it to turn sudo off.",
        );
      default:
        throw new ApiError("not_found", `There is no setup check named ${checkId}.`);
    }
  }

  /**
   * The argv of an image build: `scripts/build-image.sh`, the one source of
   * truth for the build. It passes every pin in `image/versions.env` as a
   * build argument, packs the engine in a source checkout, and uses the
   * engine tarball the package ships otherwise.
   */
  buildArgv(kind: ImageBuildKind): string[] {
    return [
      imageBuildScript(this.opts.imageContext),
      "--tag",
      this.opts.core.settings.get().engineImage,
      ...imageBuildScriptArgs(kind),
    ];
  }

  /** Builds or updates the image as an `image_build` job. */
  buildImage(kind: ImageBuildKind): Job {
    const context = this.opts.imageContext;
    if (!existsSync(join(context, "Dockerfile"))) {
      throw new ApiError(
        "image_missing",
        `The image build context ${context} has no Dockerfile. Set AIO_IMAGE_CONTEXT to the directory that holds the image's Dockerfile.`,
      );
    }
    const script = imageBuildScript(context);
    if (basename(context) !== "image" || !existsSync(script)) {
      throw new ApiError(
        "image_missing",
        `The image build needs ${script} beside the build context ${context}, and the context directory must be named image. Set AIO_IMAGE_CONTEXT to the image directory of a source checkout or of the installed package.`,
      );
    }
    const built = this.buildArgv(kind);
    // On Windows the image's user name can't come from `id -un`, so the
    // server names the one it runs `docker exec --user` with.
    const scriptArgs =
      this.platform.os === "win32"
        ? [...built.slice(1), "--user", containerUsername(this.platform.env, "win32")]
        : built.slice(1);
    const argv = bashScriptArgv(this.platform, built[0] as string, scriptArgs);
    if (!argv) {
      throw new ApiError(
        "image_missing",
        "The image build runs a bash script, and Windows has no bash. Install Git for Windows, or set AIO_BASH to a bash.exe.",
      );
    }
    // The script's `docker build` prints one line per step instead of
    // redrawing the terminal, which reads better in the job log.
    const env = { ...process.env, BUILDKIT_PROGRESS: "plain" };
    return this.opts.jobs.start({ kind: "image_build", command: commandLine(argv) }, (io) =>
      processJob(io, this.opts.runner.spawn(argv[0] as string, argv.slice(1), { pty: true, env })),
    );
  }
}
