#!/usr/bin/env node
// The `agentbox-server` entry point.
//
//   agentbox-server                  Starts the server.
//   agentbox-server install-service  Writes and enables the systemd user unit.
//
// `--data-dir PATH` (or `AGENTBOX_DATA_DIR`) moves the data directory away
// from `~/.claude-box`.
import { readFileSync, realpathSync } from "node:fs";
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
import { installService } from "./systemd/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The package version, which is also the engine version this server expects. */
export function serverVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** Quotes one `ExecStart=` word for systemd when it needs it. */
function systemdWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `"${word.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * The command line that starts this server, for the systemd unit. A data
 * directory other than the default becomes `--data-dir`, so the service
 * uses the same one as the command that installed it.
 */
export function execStartLine(dataDir?: string): string {
  const words = [process.execPath, fileURLToPath(import.meta.url)];
  if (dataDir) words.push("--data-dir", dataDir);
  return words.map(systemdWord).join(" ");
}

export interface ServerArgs {
  /** The command, or `undefined` to start the server. */
  command?: string;
  /** The absolute data directory, or `undefined` for `~/.claude-box`. */
  dataDir?: string;
  /** Set when the arguments are invalid; the caller prints it and exits 2. */
  error?: string;
}

/**
 * Parses the command line. `--data-dir PATH` and `--data-dir=PATH` win over
 * `AGENTBOX_DATA_DIR`; a relative path resolves against the working
 * directory.
 */
export function parseServerArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ServerArgs {
  let command: string | undefined;
  let dataDir: string | undefined = env[DATA_DIR_ENV] || undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--data-dir" || arg.startsWith("--data-dir=")) {
      const value = arg === "--data-dir" ? argv[++i] : arg.slice("--data-dir=".length);
      if (!value) return { error: "--data-dir needs a directory." };
      dataDir = value;
    } else if (command === undefined) {
      command = arg;
    } else {
      return { error: `Unexpected argument: ${arg}.` };
    }
  }
  return { command, dataDir: dataDir ? path.resolve(dataDir) : undefined };
}

/**
 * The home directory the server works in: `AGENTBOX_HOME` when set, so a
 * test or a second instance can run against a scratch directory, else the
 * user's home directory.
 */
export function serverHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTBOX_HOME;
  return override ? path.resolve(override) : os.homedir();
}

export async function main(argv: string[]): Promise<number> {
  const home = serverHome();
  const { command, dataDir, error } = parseServerArgs(argv);
  if (error) {
    process.stderr.write(`${error} Run agentbox-server --help.\n`);
    return 2;
  }
  if (command === "install-service") {
    const { path: unit } = await installService({
      home,
      execStart: execStartLine(dataDir),
      runner: new NodeProcessRunner(),
      log: (s) => process.stdout.write(s.replace(/\r\n/g, "\n")),
    });
    process.stdout.write(`Installed and started ${unit}.\n`);
    return 0;
  }
  if (command === "--help" || command === "-h") {
    process.stdout.write(
      "Usage: agentbox-server [--data-dir PATH] [install-service]\n\n" +
        "Without a command, starts the Agent Box server: the API over HTTPS on 127.0.0.1,\n" +
        "with the certificate in server.crt, and the dev-server proxy over HTTP.\n" +
        "install-service writes ~/.config/systemd/user/agentbox-server.service and enables it.\n\n" +
        "Options:\n" +
        "  --data-dir PATH         The directory for agentbox.db, server.token, server.crt, server.key,\n" +
        "                          state/, sessions/, and the 3.x records to import.\n" +
        "                          Default: ~/.claude-box.\n\n" +
        "Environment:\n" +
        "  AGENTBOX_DATA_DIR       The data directory, when --data-dir isn't given.\n" +
        "  AGENTBOX_HOME           The home directory to use in place of yours.\n" +
        "  AGENTBOX_ENGINE_VERSION The engine version to expect. Default: this server's version plus the\n" +
        "                          engine's content hash, VERSION+HASH, when the build wrote one.\n" +
        "  AGENTBOX_IMAGE_CONTEXT  The image build context, an image/ directory with scripts/build-image.sh\n" +
        "                          beside it. Default: image/ in the repository, else\n" +
        "                          /usr/share/agentbox/image.\n" +
        "  AGENTBOX_BOXES_DIR      The built Boxes app to serve at /boxes/.\n" +
        "  AGENTBOX_REVIEW_DIR     The built Review app to serve at /review/.\n" +
        "  AGENTBOX_DEV_ENGINES    Development only: engines for projects without a container,\n" +
        "                          as projectId=host:port:token[,...]. The host must be loopback.\n",
    );
    return 0;
  }
  if (command !== undefined) {
    process.stderr.write(`Unknown command: ${command}. Run agentbox-server --help.\n`);
    return 2;
  }

  const version = serverVersion();
  const devEngines = parseDevEngines(process.env[DEV_ENGINES_ENV]);
  const repoRoot = path.resolve(here, "..", "..", "..");
  const imageContext = process.env.AGENTBOX_IMAGE_CONTEXT ?? defaultImageContext(repoRoot);
  const app = await startApp({
    home,
    dataDir,
    createCore,
    version,
    expectedEngineVersion:
      process.env.AGENTBOX_ENGINE_VERSION ??
      expectedEngineVersion(version, engineIdentityFiles(repoRoot, imageContext)),
    execStart: execStartLine(dataDir),
    devEngines,
    imageContext,
    staticDirs: {
      boxes: process.env.AGENTBOX_BOXES_DIR ?? defaultStaticDir(repoRoot, "boxes"),
      review: process.env.AGENTBOX_REVIEW_DIR ?? defaultStaticDir(repoRoot, "review"),
    },
  });
  process.stderr.write(`agentbox-server ${version} listening on https://127.0.0.1:${app.port}\n`);
  if (app.proxyPort !== null) {
    process.stderr.write(`Dev-server proxy on http://*.localhost:${app.proxyPort}\n`);
  }
  if (dataDir) process.stderr.write(`Using the data directory ${dataDir}.\n`);

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
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`agentbox-server failed: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
