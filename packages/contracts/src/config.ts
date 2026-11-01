// Server configuration and the environment the server passes to each engine.
import { z } from "zod";
import { PortSchema } from "./common.js";
import { DEFAULT_ENGINE_PORT, GlobalSettingsInputSchema, type GlobalSettings } from "./records.js";

/** Files under the home directory, relative to it. */
export const HOME_PATHS = {
  dataDir: ".ai-orchestrator",
  config: ".ai-orchestrator/config.json",
  database: ".ai-orchestrator/aio.db",
  /** The server's bearer token, mode 0600. */
  serverToken: ".ai-orchestrator/server.token",
  /**
   * The server's self-signed TLS certificate, which every client pins. See
   * `@aio/contracts/tls`.
   */
  serverCert: ".ai-orchestrator/server.crt",
  /** The private key of `serverCert`, mode 0600. */
  serverKey: ".ai-orchestrator/server.key",
  /**
   * The port the running server listens on, which the server writes at
   * every start. The CLI reads it before `config.json`, since the server
   * takes its port from its database after the first start.
   */
  serverPort: ".ai-orchestrator/server.port",
  /** Per-container keeper state: `state/<container>/sessions` and `mounts`. */
  stateDir: ".ai-orchestrator/state",
  /** Per-container Claude sessions directory, mounted over `~/.claude/sessions`. */
  sessionsDir: ".ai-orchestrator/sessions",
  /** Per-container secrets broker directory, `broker/<container>/broker.sock`. */
  brokerDir: ".ai-orchestrator/broker",
  backupDir: ".ai-orchestrator/backup",
} as const;

/** Run files, relative to the project root: `<project>/.aio/runs/<run id>/`. */
export const RUNS_DIR = ".aio/runs";

/** The file inside the image that names the engine version it carries. */
export const ENGINE_VERSION_FILE = "/etc/aio-engine-version";

/**
 * The configuration file schema: global settings with defaults. Its output is
 * a complete `GlobalSettings`.
 */
export const ServerConfigSchema = GlobalSettingsInputSchema;
export type ServerConfig = GlobalSettings;

/**
 * Parses `~/.ai-orchestrator/config.json` content and fills every missing field
 * with its default. `undefined` and `null` (no file) give the full default
 * configuration. Throws a `ZodError` when a present field is invalid or a key
 * is unknown.
 */
export function parseConfig(input: unknown): ServerConfig {
  return ServerConfigSchema.parse(input ?? {});
}

/** The configuration with every field at its default. */
export function defaultConfig(): ServerConfig {
  return parseConfig({});
}

/** Environment variable names the server sets on every project container. */
export const ENGINE_ENV = {
  /**
   * Bearer token the engine requires on every request, for an engine started
   * by hand in development. Ignored when `tokenFile` is set.
   */
  token: "AIO_ENGINE_TOKEN",
  /**
   * File that holds the bearer token. The server sets this rather than
   * `token`, so the token stays out of the container's environment.
   */
  tokenFile: "AIO_ENGINE_TOKEN_FILE",
  /** Port the engine listens on inside the container. */
  port: "AIO_ENGINE_PORT",
  /** The project root as the container sees it. */
  projectRoot: "AIO_PROJECT_ROOT",
  /** The container's own name, used in event sources (`engine:<container>`). */
  container: "AIO_CONTAINER",
  /**
   * The engine version the server expects. On a mismatch the engine still
   * starts, logs a warning, and reports `versionMatches: false` on its health
   * route.
   */
  engineVersion: "AIO_ENGINE_VERSION",
  /** The keeper's state directory inside the container, which holds the `sessions` file. */
  stateDir: "AIO_STATE_DIR",
} as const;

/** The container path the server mounts the keeper's state directory at. */
export const DEFAULT_ENGINE_STATE_DIR = "/run/aio";

/**
 * The engine's view of its environment, after parsing. It needs the token
 * file or the token itself; the engine prefers the file when both are set.
 */
export const EngineEnvSchema = z
  .object({
    [ENGINE_ENV.token]: z.string().min(16).optional(),
    [ENGINE_ENV.tokenFile]: z.string().trim().min(1).optional(),
    [ENGINE_ENV.port]: z.coerce.number().pipe(PortSchema).default(DEFAULT_ENGINE_PORT),
    [ENGINE_ENV.projectRoot]: z.string().min(1),
    [ENGINE_ENV.container]: z.string().min(1),
    [ENGINE_ENV.engineVersion]: z.string().min(1),
    [ENGINE_ENV.stateDir]: z.string().min(1).default(DEFAULT_ENGINE_STATE_DIR),
  })
  .refine((env) => env[ENGINE_ENV.tokenFile] !== undefined || env[ENGINE_ENV.token] !== undefined, {
    message: `Set ${ENGINE_ENV.tokenFile} or ${ENGINE_ENV.token}.`,
    path: [ENGINE_ENV.tokenFile],
  });
export type EngineEnv = z.infer<typeof EngineEnvSchema>;

/** Parses the engine's settings from an environment such as `process.env`. */
export function parseEngineEnv(env: Record<string, string | undefined>): EngineEnv {
  return EngineEnvSchema.parse(env);
}
