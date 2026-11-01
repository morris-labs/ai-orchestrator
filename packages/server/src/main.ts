#!/usr/bin/env node
// The `aio-server` entry point.
//
//   aio-server                  Starts the server.
//   aio-server install-service  Writes and enables the service that starts the
//                               server at login: a systemd user unit on Linux,
//                               a launchd agent on macOS, a Task Scheduler
//                               logon task on Windows.
//
// `--data-dir PATH` (or `AIO_DATA_DIR`) moves the data directory away
// from `~/.ai-orchestrator`.
import { createWriteStream, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp } from "./api/app.js";
import { createCore } from "./core.js";
import { defaultStaticDir } from "./api/static-dirs.js";
import { engineIdentityFiles, expectedEngineVersion } from "./docker/engine-identity.js";
import { defaultImageContext } from "./docker/image.js";
import { DEV_ENGINES_ENV, parseDevEngines } from "./events/dev-engines.js";
import { NodeProcessRunner } from "./jobs/process.js";
import { DATA_DIR_ENV } from "./records/env.js";
import { ROLE_ENV, parseRole, type MachineRole } from "./hub/multihost.js";
import { currentPlatform, serviceEnvFromFile, type HostPlatform } from "./platform/host.js";
import { installServerService, serviceSummary, systemdExecStart } from "./service/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The package version, which is also the engine version this server expects. */
export function serverVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/**
 * The argv that starts this server, for the service. A data directory
 * other than the default becomes `--data-dir`, so the service uses the
 * same one as the command that installed it.
 */
export function serverCommand(dataDir?: string): string[] {
  const words = [process.execPath, fileURLToPath(import.meta.url)];
  if (dataDir) words.push("--data-dir", dataDir);
  return words;
}

/** The command line that starts this server, for the systemd unit. */
export function execStartLine(dataDir?: string): string {
  return systemdExecStart(serverCommand(dataDir));
}

/**
 * The directory that holds the image build context, its scripts, and the
 * web bundles in the macOS and Windows packages, beside the server:
 * `runtime/share` when the server is `runtime/server/dist/main.js`. See
 * `scripts/stage-runtime.mjs`.
 */
export const bundledShareDir = path.resolve(here, "..", "..", "share");

export interface ServerArgs {
  /** The command, or `undefined` to start the server. */
  command?: string;
  /** The absolute data directory, or `undefined` for `~/.ai-orchestrator`. */
  dataDir?: string;
  /** The role for this run, from `--role` or `AIO_ROLE`; `undefined` uses the stored one. */
  role?: MachineRole;
  /** The absolute file that standard error goes to, or `undefined` for standard error. */
  logFile?: string;
  /** Set when the arguments are invalid; the caller prints it and exits 2. */
  error?: string;
}

/**
 * Parses the command line. `--data-dir PATH` and `--data-dir=PATH` win over
 * `AIO_DATA_DIR`; a relative path resolves against the working
 * directory.
 */
export function parseServerArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ServerArgs {
  let command: string | undefined;
  let dataDir: string | undefined = env[DATA_DIR_ENV] || undefined;
  let roleText: string | undefined = env[ROLE_ENV] || undefined;
  let roleSource = ROLE_ENV;
  let logFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--data-dir" || arg.startsWith("--data-dir=")) {
      const value = arg === "--data-dir" ? argv[++i] : arg.slice("--data-dir=".length);
      if (!value) return { error: "--data-dir needs a directory." };
      dataDir = value;
    } else if (arg === "--role" || arg.startsWith("--role=")) {
      const value = arg === "--role" ? argv[++i] : arg.slice("--role=".length);
      if (!value) return { error: "--role needs hub, node, or both." };
      roleText = value;
      roleSource = "--role";
    } else if (arg === "--log-file" || arg.startsWith("--log-file=")) {
      const value = arg === "--log-file" ? argv[++i] : arg.slice("--log-file=".length);
      if (!value) return { error: "--log-file needs a file." };
      logFile = path.resolve(value);
    } else if (command === undefined) {
      command = arg;
    } else {
      return { error: `Unexpected argument: ${arg}.` };
    }
  }
  const role = parseRole(roleText);
  if (roleText !== undefined && role === undefined) {
    return { error: `${roleSource} must be hub, node, or both, not ${roleText}.` };
  }
  return {
    command,
    dataDir: dataDir ? path.resolve(dataDir) : undefined,
    ...(logFile ? { logFile } : {}),
    ...(role ? { role } : {}),
  };
}

/**
 * Sends standard error to `file`, appending. The Windows logon task runs
 * the server without a console, so this is where its messages go.
 */
function logToFile(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const stream = createWriteStream(file, { flags: "a" });
  process.stderr.write = stream.write.bind(stream) as typeof process.stderr.write;
}

/** The help text, with the service that `install-service` writes on `platform`. */
export function helpText(platform: HostPlatform): string {
  const service = serviceSummary(platform);
  const installs =
    service.kind === "systemd"
      ? `install-service writes ${service.where} and enables it.`
      : service.kind === "launchd"
        ? `install-service writes ${service.where} and loads it with launchctl.`
        : `install-service registers ${service.where}, which starts the server at logon.`;
  return (
    "Usage: aio-server [--data-dir PATH] [--log-file FILE] [--role ROLE] [install-service]\n\n" +
    "Without a command, starts the AI Orchestrator server: the API over HTTPS on 127.0.0.1,\n" +
    "with the certificate in server.crt, and the dev-server proxy over HTTP.\n" +
    `${installs}\n\n` +
    "Options:\n" +
    "  --data-dir PATH         The directory for aio.db, server.token, server.crt, server.key,\n" +
    "                          state/, sessions/, and the 3.x records to import.\n" +
    "                          Default: ~/.ai-orchestrator.\n" +
    "  --log-file FILE         Append standard error to FILE. The Windows logon task uses it.\n" +
    "  --role ROLE             This run's multi-host role: hub, node, or both. Default: the role\n" +
    "                          in the settings, else both. A hub listens for node links on port\n" +
    "                          21402 on every interface once it has issued an enrollment code.\n\n" +
    "Environment:\n" +
    "  AIO_DATA_DIR       The data directory, when --data-dir isn't given.\n" +
    "  AIO_ROLE           The role, when --role isn't given.\n" +
    "  AIO_HOME           The home directory to use in place of yours.\n" +
    "  AIO_ENGINE_VERSION The engine version to expect. Default: this server's version plus the\n" +
    "                          engine's content hash, VERSION+HASH, when the build wrote one.\n" +
    "  AIO_IMAGE_CONTEXT  The image build context, an image/ directory with scripts/build-image.sh\n" +
    "                          beside it. Default: image/ in the repository, else\n" +
    "                          /usr/share/ai-orchestrator/image, else the one beside the server.\n" +
    "  AIO_BOXES_DIR      The built Boxes app to serve at /boxes/.\n" +
    "  AIO_REVIEW_DIR     The built Review app to serve at /review/.\n" +
    "  AIO_BASH           The bash that runs the image build script; on Windows, the default is\n" +
    "                          Git for Windows' bash.exe.\n" +
    "  AIO_DEV_ENGINES    Development only: engines for projects without a container,\n" +
    "                          as projectId=host:port:token[,...]. The host must be loopback.\n"
  );
}

/**
 * The home directory the server works in: `AIO_HOME` when set, so a
 * test or a second instance can run against a scratch directory, else the
 * user's home directory.
 */
export function serverHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AIO_HOME;
  return override ? path.resolve(override) : os.homedir();
}

export async function main(argv: string[]): Promise<number> {
  const home = serverHome();
  const platform = currentPlatform(home);
  const { command, dataDir, logFile, role, error } = parseServerArgs(argv);
  if (error) {
    process.stderr.write(`${error} Run aio-server --help.\n`);
    return 2;
  }
  if (logFile) logToFile(logFile);
  if (command === "install-service") {
    const { path: unit } = await installServerService({
      platform,
      command: serverCommand(dataDir),
      dataDir,
      runner: new NodeProcessRunner(),
      log: (s) => process.stdout.write(s.replace(/\r\n/g, "\n")),
    });
    process.stdout.write(`Installed and started ${unit}.\n`);
    return 0;
  }
  if (command === "--help" || command === "-h") {
    process.stdout.write(helpText(platform));
    return 0;
  }
  if (command !== undefined) {
    process.stderr.write(`Unknown command: ${command}. Run aio-server --help.\n`);
    return 2;
  }

  // macOS and Windows: the 1Password token file that systemd's
  // EnvironmentFile= loads on Linux.
  Object.assign(
    process.env,
    serviceEnvFromFile(platform, (f) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return null;
      }
    }),
  );
  const version = serverVersion();
  const devEngines = parseDevEngines(process.env[DEV_ENGINES_ENV]);
  const repoRoot = path.resolve(here, "..", "..", "..");
  const imageContext =
    process.env.AIO_IMAGE_CONTEXT ?? defaultImageContext(repoRoot, undefined, bundledShareDir);
  const app = await startApp({
    home,
    dataDir,
    createCore,
    version,
    role,
    expectedEngineVersion:
      process.env.AIO_ENGINE_VERSION ??
      expectedEngineVersion(version, engineIdentityFiles(repoRoot, imageContext)),
    execStart: execStartLine(dataDir),
    serverCommand: serverCommand(dataDir),
    platform,
    devEngines,
    imageContext,
    staticDirs: {
      boxes:
        process.env.AIO_BOXES_DIR ??
        defaultStaticDir(repoRoot, "boxes", undefined, bundledShareDir),
      review:
        process.env.AIO_REVIEW_DIR ??
        defaultStaticDir(repoRoot, "review", undefined, bundledShareDir),
    },
  });
  process.stderr.write(`aio-server ${version} listening on https://127.0.0.1:${app.port}\n`);
  if (app.proxyPort !== null) {
    process.stderr.write(`Dev-server proxy on http://*.localhost:${app.proxyPort}\n`);
  }
  if (dataDir) process.stderr.write(`Using the data directory ${dataDir}.\n`);
  if (role) process.stderr.write(`Running with the role ${role}.\n`);
  const linkPort = app.multiHost.hub.port;
  if (linkPort !== null)
    process.stderr.write(`Hub listening for node links on port ${linkPort}.\n`);

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = (signal: string) => {
      if (closing) return;
      closing = true;
      process.stderr.write(`Received ${signal}; shutting down.\n`);
      const force = setTimeout(() => process.exit(1), 10_000);
      force.unref();
      void app.close().finally(resolve);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    // Windows delivers no SIGTERM; Ctrl+Break in a console arrives as SIGBREAK.
    if (platform.os === "win32") process.on("SIGBREAK", () => shutdown("SIGBREAK"));
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`aio-server failed: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
