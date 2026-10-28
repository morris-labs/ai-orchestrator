#!/usr/bin/env node
// The `agentbox-server` entry point.
//
//   agentbox-server                  Starts the server.
//   agentbox-server install-service  Writes and enables the systemd user unit.
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CoreFactory } from "./api/core-interface.js";
import { startApp } from "./api/app.js";
import { NodeProcessRunner } from "./jobs/process.js";
import { installService } from "./systemd/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The package version, which is also the engine version this server expects. */
export function serverVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** The command line that starts this server, for the systemd unit. */
export function execStartLine(): string {
  return `${process.execPath} ${fileURLToPath(import.meta.url)}`;
}

async function loadCoreFactory(): Promise<CoreFactory> {
  // W1's `src/core.ts`; the specifier is a variable so this file builds
  // before that module exists.
  const specifier = "./core.js";
  const mod = (await import(specifier)) as { createCore?: CoreFactory };
  if (typeof mod.createCore !== "function") throw new Error("core.js does not export createCore.");
  return mod.createCore;
}

export async function main(argv: string[]): Promise<number> {
  const home = os.homedir();
  const [command] = argv;
  if (command === "install-service") {
    const { path: unit } = await installService({
      home,
      execStart: execStartLine(),
      runner: new NodeProcessRunner(),
      log: (s) => process.stdout.write(s.replace(/\r\n/g, "\n")),
    });
    process.stdout.write(`Installed and started ${unit}.\n`);
    return 0;
  }
  if (command === "--help" || command === "-h") {
    process.stdout.write(
      "Usage: agentbox-server [install-service]\n\n" +
        "Without a command, starts the Agent Box server on 127.0.0.1.\n" +
        "install-service writes ~/.config/systemd/user/agentbox-server.service and enables it.\n",
    );
    return 0;
  }
  if (command !== undefined) {
    process.stderr.write(`Unknown command: ${command}. Run agentbox-server --help.\n`);
    return 2;
  }

  const version = serverVersion();
  const repoRoot = path.resolve(here, "..", "..", "..");
  const app = await startApp({
    home,
    createCore: await loadCoreFactory(),
    version,
    expectedEngineVersion: process.env.AGENTBOX_ENGINE_VERSION ?? version,
    execStart: execStartLine(),
    imageContext: process.env.AGENTBOX_IMAGE_CONTEXT ?? path.join(repoRoot, "image"),
    staticDirs: {
      boxes: process.env.AGENTBOX_BOXES_DIR ?? path.join(repoRoot, "apps", "boxes", "dist"),
      review: process.env.AGENTBOX_REVIEW_DIR ?? path.join(repoRoot, "apps", "review", "dist"),
    },
  });
  process.stderr.write(`agentbox-server ${version} listening on 127.0.0.1:${app.port}\n`);

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
