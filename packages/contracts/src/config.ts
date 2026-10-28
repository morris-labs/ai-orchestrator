// Server configuration and the environment the server passes to each engine.
import { z } from "zod";
import { PortSchema } from "./common.js";
import { DEFAULT_ENGINE_PORT, GlobalSettingsSchema, type GlobalSettings } from "./records.js";

/**
 * Files under the home directory, relative to it. The `~/.claude-box`
 * directory name stays from 3.x so the import finds the old records.
 */
export const HOME_PATHS = {
  dataDir: ".claude-box",
  config: ".claude-box/config.json",
  database: ".claude-box/agentbox.db",
  /** The server's bearer token, mode 0600. */
  serverToken: ".claude-box/server.token",
  /** Per-container keeper state: `state/<container>/sessions` and `mounts`. */
  stateDir: ".claude-box/state",
  /** Per-container Claude sessions directory, mounted over `~/.claude/sessions`. */
  sessionsDir: ".claude-box/sessions",
  backupDir: ".claude-box/backup",
} as const;

/** Run files, relative to the project root: `<project>/.claude-box/runs/<run id>/`. */
export const RUNS_DIR = ".claude-box/runs";

/** The file inside the image that names the engine version it carries. */
export const ENGINE_VERSION_FILE = "/etc/agentbox-engine-version";

/** The server configuration is the global settings file. */
export const ServerConfigSchema = GlobalSettingsSchema;
export type ServerConfig = GlobalSettings;

/**
 * Parses `~/.claude-box/config.json` content and fills every missing field
 * with its default. `undefined` and `null` (no file) give the full default
 * configuration. Throws a `ZodError` when a present field is invalid.
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
  /** Bearer token the engine requires on every request. */
  token: "AGENTBOX_ENGINE_TOKEN",
  /** Port the engine listens on inside the container. */
  port: "AGENTBOX_ENGINE_PORT",
  /** The project root as the container sees it. */
  projectRoot: "AGENTBOX_PROJECT_ROOT",
  /** The container's own name, used in event sources (`engine:<container>`). */
  container: "AGENTBOX_CONTAINER",
  /** The engine version the server expects; the engine refuses to start on a mismatch. */
  engineVersion: "AGENTBOX_ENGINE_VERSION",
} as const;

/** The engine's view of its environment, after parsing. */
export const EngineEnvSchema = z.object({
  [ENGINE_ENV.token]: z.string().min(16),
  [ENGINE_ENV.port]: z.coerce.number().pipe(PortSchema).default(DEFAULT_ENGINE_PORT),
  [ENGINE_ENV.projectRoot]: z.string().min(1),
  [ENGINE_ENV.container]: z.string().min(1),
  [ENGINE_ENV.engineVersion]: z.string().min(1),
});
export type EngineEnv = z.infer<typeof EngineEnvSchema>;

/** Parses the engine's settings from an environment such as `process.env`. */
export function parseEngineEnv(env: Record<string, string | undefined>): EngineEnv {
  return EngineEnvSchema.parse(env);
}
