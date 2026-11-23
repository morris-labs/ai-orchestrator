// Starts the engine: environment, logging, event stream, leases, core,
// repositories, port discovery, API, and the active-runs file, in that
// order, and stops them in reverse on a signal.
import {
  BROKER_ENV,
  DEFAULT_ENGINE_STATE_DIR,
  ENGINE_ENV,
  EngineEnvSchema,
  type EngineEnv,
} from "@aio/contracts";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { type LogLevel, type Logger, type RunManager } from "../api/core-interface.js";
import { RepoService } from "../api/repos.js";
import { execRunner, type CommandRunner } from "../api/runner.js";
import { buildEngineApp } from "../api/server.js";
import { EventHub } from "../events/hub.js";
import { EngineLeaseBroker } from "../events/leases.js";
import { scanListeners } from "../ports/scan.js";
import { PortWatcher } from "../ports/watcher.js";
import type { AdapterSet } from "../core.js";
import { createBuildManager, type BuildManager } from "../build/manager.js";
import { createRunManager } from "../state/manager.js";
import { ChildRegistry, setChildRegistry } from "../process/children.js";
import { setCredentialSource } from "../process/credentials.js";
import { looksLikeCredential } from "../process/env.js";
import { BrokerClient } from "../secrets/broker-client.js";
import { moveSecretsOutOfEnviron } from "./environ.js";
import { startActiveRunsWriter } from "./active-runs.js";
import { MOCK_SCRIPT_ENV, MOCK_VENDORS_ENV, selectAdapters } from "./adapters.js";
import { LOG_LEVELS, createLogger, isLogLevel } from "./logger.js";
import { loadEngineToken } from "./token.js";
import { readPackageVersion } from "./version.js";

export const LOG_LEVEL_ENV = "AIO_LOG_LEVEL";

export const USAGE = `Usage: aio-engine [--log-level LEVEL]

Runs the AI Orchestrator engine inside a project container.

Options:
  --log-level LEVEL  One of ${LOG_LEVELS.join(", ")}. Default: $${LOG_LEVEL_ENV}, or info.
  --version          Print the engine version and exit.
  --help             Print this help and exit.

Environment:
  ${ENGINE_ENV.tokenFile}  File that holds the bearer token for every request, 16
                         characters or more. This or ${ENGINE_ENV.token} is required.
  ${ENGINE_ENV.token}    The bearer token itself, for an engine started by hand in
                         development. Ignored when ${ENGINE_ENV.tokenFile} is set.
  ${ENGINE_ENV.port}     Port to listen on. Default: 20411.
  ${ENGINE_ENV.projectRoot}   The project root as the container sees it. Required.
  ${ENGINE_ENV.container}      The container's name. Required.
  ${ENGINE_ENV.engineVersion}  The engine version the server expects. Required.
  ${ENGINE_ENV.stateDir}       Where to write active-runs. Default: ${DEFAULT_ENGINE_STATE_DIR}.
  ${MOCK_VENDORS_ENV}    Vendors whose calls mock scripts answer: 1 for all, or a list
                         such as codex,copilot.
  ${MOCK_SCRIPT_ENV}     With ${MOCK_VENDORS_ENV}: a JSON file of responses per vendor.
`;

export interface CliArgs {
  logLevel: LogLevel | null;
  help: boolean;
  version: boolean;
}

/** Parses the engine's command line. Throws with a message for a bad argument. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { logLevel: null, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version") args.version = true;
    else if (a === "--log-level" || a.startsWith("--log-level=")) {
      const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (value === undefined || !isLogLevel(value)) {
        throw new Error(`--log-level takes one of: ${LOG_LEVELS.join(", ")}.`);
      }
      args.logLevel = value;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/**
 * Validates the engine's environment. Returns the parsed settings or the
 * names of the variables that are missing or invalid, never their values.
 */
export function checkEnv(
  env: Record<string, string | undefined>,
): { ok: true; env: EngineEnv } | { ok: false; problems: string[] } {
  const parsed = EngineEnvSchema.safeParse(env);
  if (parsed.success) return { ok: true, env: parsed.data };
  const problems = parsed.error.issues.map((issue) => {
    if (issue.code === "custom") return issue.message;
    const name = String(issue.path[0] ?? "environment");
    if (env[name] === undefined || env[name] === "") return `${name} isn't set.`;
    if (name === ENGINE_ENV.token) return `${name} must be at least 16 characters.`;
    return `${name} is invalid: ${issue.message}`;
  });
  return { ok: false, problems: [...new Set(problems)] };
}

export interface EngineHandle {
  app: FastifyInstance;
  hub: EventHub;
  leases: EngineLeaseBroker;
  runs: RunManager;
  builds: BuildManager;
  ports: PortWatcher;
  /** The address the API listens on. */
  address: { host: string; port: number };
  close(): Promise<void>;
}

export interface StartOptions {
  env: EngineEnv;
  /** The bearer token the API requires, from `loadEngineToken`. */
  token: string;
  log: Logger;
  /** Where to write `active-runs`. Defaults to `AIO_STATE_DIR`. */
  stateDir?: string;
  host?: string;
  runner?: CommandRunner;
  /** The vendor adapters for the core. Defaults to an empty set. */
  adapters?: AdapterSet;
  /** Replaces the core, for tests. */
  runs?: RunManager;
  /** Replaces the build manager, for tests. */
  builds?: BuildManager;
  portIntervalMs?: number;
}

/** Starts every part of the engine and returns a handle that stops them. */
export async function startEngine(options: StartOptions): Promise<EngineHandle> {
  const { env, log } = options;
  const runner = options.runner ?? execRunner;
  const container = env[ENGINE_ENV.container];
  const projectRoot = env[ENGINE_ENV.projectRoot];
  const port = env[ENGINE_ENV.port];
  const engineVersion = readPackageVersion();
  const expectedVersion = env[ENGINE_ENV.engineVersion];
  if (engineVersion !== expectedVersion) {
    log.warn("The engine version differs from the one the server expects", {
      engineVersion,
      expectedVersion,
    });
  }

  const hub = new EventHub({ source: `engine:${container}` });
  const leases = new EngineLeaseBroker({ log });
  let runs: RunManager;
  try {
    runs =
      options.runs ??
      (await createRunManager({
        projectRoot,
        container,
        events: hub,
        leases,
        adapters: options.adapters ?? {},
        log,
      }));
  } catch (err) {
    leases.close();
    throw err;
  }
  let builds: BuildManager;
  try {
    builds =
      options.builds ??
      (await createBuildManager({
        projectRoot,
        container,
        events: hub,
        leases,
        adapters: options.adapters ?? {},
        log,
        reviews: runs,
      }));
  } catch (err) {
    await runs.close?.();
    leases.close();
    throw err;
  }
  const repos = new RepoService({ projectRoot, runner, log });
  const ports = new PortWatcher({
    container,
    events: hub,
    log,
    intervalMs: options.portIntervalMs,
    scan: () => scanListeners({ runner, excludePorts: [port] }),
  });
  ports.start();

  const app = await buildEngineApp({
    token: options.token,
    container,
    projectRoot,
    engineVersion,
    expectedVersion,
    hub,
    leases,
    log,
    runs,
    builds,
    repos,
    ports,
  });
  const host = options.host ?? "0.0.0.0";
  try {
    await app.listen({ host, port });
  } catch (err) {
    await ports.stop();
    leases.close();
    throw err;
  }
  const bound = app.server.address();
  const boundPort = typeof bound === "object" && bound ? bound.port : port;
  log.info("The engine is listening", { host, port: boundPort, engineVersion, container });

  const stateDir = options.stateDir ?? env[ENGINE_ENV.stateDir];
  const activeRuns = startActiveRunsWriter(
    stateDir,
    () => runs.activeRunCount() + builds.activeCount(),
    log,
  );

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      log.info("The engine is shutting down");
      await ports.stop();
      await app.close();
      // The runs learn that the engine is stopping before the broker rejects
      // their pending lease requests, so those runs stay `running` and the
      // next engine continues them instead of finding them failed.
      const runsClosed = runs.close?.();
      const buildsClosed = builds.close();
      leases.close();
      await Promise.all([runsClosed, buildsClosed]);
      activeRuns.stop(0);
      log.info("The engine stopped");
    })();
    return closing;
  };
  return { app, hub, leases, runs, builds, ports, address: { host, port: boundPort }, close };
}

/**
 * The command-line entry point. Returns the process exit code for early
 * exits; on a normal start it resolves once a signal has stopped the engine.
 */
export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }
  const envLevel = env[LOG_LEVEL_ENV];
  const level: LogLevel = args.logLevel ?? (envLevel && isLogLevel(envLevel) ? envLevel : "info");
  const log = createLogger(level);

  if (env === process.env) {
    // Executes the engine again without its credentials in the environ, the
    // first time through; returns once they are back in `process.env`.
    const step = moveSecretsOutOfEnviron({ isSecret: looksLikeCredential });
    if (step.kind === "unsupported") {
      log.warn(
        "This Node has no process.execve, so the engine's /proc environ still holds its credentials",
        { names: step.names },
      );
    }
  }

  const checked = checkEnv(env);
  if (!checked.ok) {
    for (const problem of checked.problems) log.error(`The engine refuses to start: ${problem}`);
    return 2;
  }
  const loaded = loadEngineToken(checked.env);
  if (!loaded.ok) {
    log.error(`The engine refuses to start: ${loaded.problem}`);
    return 2;
  }

  // The token stays in `loaded.token` for the API. Removing it, and the name
  // of its file, from `process.env` keeps both out of every child, whatever
  // runner starts the child. `/proc/PID/environ` doesn't change when
  // `process.env` does; `moveSecretsOutOfEnviron` above keeps the token out
  // of it.
  if (env === process.env) {
    delete process.env[ENGINE_ENV.token];
    delete process.env[ENGINE_ENV.tokenFile];
  }

  // Before any run resumes, stop the vendor CLIs and commands that a crashed
  // engine in this container left running, so a resumed fixer never works
  // beside an orphaned one.
  const children = new ChildRegistry(
    join(checked.env[ENGINE_ENV.stateDir], "engine-children.json"),
  );
  const reaped = children.reap();
  if (reaped > 0)
    log.warn("Stopped process groups that an earlier engine left running", { reaped });
  setChildRegistry(children);

  // The server sets the broker socket on every container it creates; an
  // engine started by hand without it gives children no brokered credentials.
  if (env[BROKER_ENV.socket] || env[BROKER_ENV.url]) {
    try {
      setCredentialSource(new BrokerClient({ env }), (message, fields) =>
        log.warn(message, fields),
      );
    } catch (err) {
      log.warn("The engine can't use the secrets broker", { reason: (err as Error).message });
    }
  }

  let handle: EngineHandle;
  try {
    const { adapters } = await selectAdapters(env, log);
    handle = await startEngine({ env: checked.env, token: loaded.token, log, adapters });
  } catch (err) {
    log.error("The engine failed to start", { error: String(err) });
    return 1;
  }

  return new Promise<number>((resolve) => {
    let signals = 0;
    const onSignal = (signal: NodeJS.Signals) => {
      signals += 1;
      if (signals > 1) {
        log.warn("Second signal; exiting without a clean shutdown", { signal });
        resolve(1);
        return;
      }
      log.info("Received a signal", { signal });
      const force = setTimeout(() => {
        log.error("Shutdown took longer than 10 seconds; exiting");
        resolve(1);
      }, 10_000);
      force.unref();
      handle.close().then(
        () => resolve(0),
        (err: unknown) => {
          log.error("Shutdown failed", { error: String(err) });
          resolve(1);
        },
      );
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  });
}
