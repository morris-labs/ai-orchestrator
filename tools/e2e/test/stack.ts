// Starts the sample repository, the built engine as a local process that
// stands in for a project container, and the built server that subscribes
// to it through `AIO_DEV_ENGINES`. Each test file starts its own stack.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { projectContainerName } from "@aio/contracts";
import { pinFromPem, pinnedFetch } from "@aio/contracts/tls";
import {
  ENGINE_MAIN,
  SAMPLE_BUILD,
  SERVER_MAIN,
  childEnv,
  freePort,
  projectIdForRoot,
  requireBuilt,
  startProcess,
  waitFor,
  type Proc,
} from "./harness.js";

/**
 * The engine's identity, `VERSION+HASH` once the engine is built. The engine
 * reports it, and the server compares the engine's health reply with
 * `AIO_ENGINE_VERSION`, so both processes get the same value. A plain
 * version makes the server refuse the subscription (versionMatches false).
 */
export function engineIdentity(): string {
  const version = (
    JSON.parse(
      readFileSync(path.join(path.dirname(ENGINE_MAIN), "..", "package.json"), "utf8"),
    ) as { version: string }
  ).version;
  try {
    const hash = readFileSync(path.join(path.dirname(ENGINE_MAIN), "identity"), "utf8").trim();
    return /^[0-9a-f]{8,64}$/.test(hash) ? `${version}+${hash}` : version;
  } catch {
    return version;
  }
}

export interface StackOptions {
  /**
   * Extra engine environment that picks the vendors, such as
   * `AIO_MOCK_VENDORS` or a `PATH` with the mock CLIs first. It may refer
   * to the stack's folder, so it is a function of that folder.
   */
  engineEnv(dir: string): Record<string, string>;
  /** Prepares the sample repository before the engine starts. */
  prepareRepo?(repo: string): void;
}

export interface Stack {
  /** The stack's temporary folder. */
  dir: string;
  /** The sample repository, the project root. */
  repo: string;
  projectId: string;
  /** The engine's state folder, which also holds the build socket. */
  stateDir: string;
  /** The server's home folder. */
  home: string;
  engineToken: string;
  /** The running engine; `restartEngine()` replaces it. */
  engine(): Proc;
  server: Proc;
  /** The environment for the `aio` CLI. */
  cliEnv: NodeJS.ProcessEnv;
  /** Calls the server's API and returns the parsed answer; throws unless it succeeds. */
  api(method: string, route: string, body?: unknown): Promise<unknown>;
  /** Opens the server's SQLite database read-only. Close it after use. */
  db(): Database.Database;
  /** Stops the engine with SIGTERM, starts a new one, and waits for the server to subscribe again. */
  restartEngine(): Promise<void>;
  /** Kills both processes and removes the folder unless `AIO_E2E_KEEP=1`. */
  close(): void;
}

function subscriptions(proc: Proc): number {
  return proc.output().match(/Event subscriber connected/g)?.length ?? 0;
}

export async function startStack(options: StackOptions): Promise<Stack> {
  requireBuilt();
  const dir = mkdtempSync(path.join(os.tmpdir(), "aio-e2e-"));
  const repo = execFileSync(SAMPLE_BUILD, [path.join(dir, "sample")], { encoding: "utf8" }).trim();
  options.prepareRepo?.(repo);
  const projectId = projectIdForRoot(repo);

  const enginePort = await freePort();
  const serverPort = await freePort();
  const engineToken = randomBytes(24).toString("hex");
  const stateDir = path.join(dir, "state");
  mkdirSync(stateDir);
  // The engine reads its token from a file, as in a container, so the token
  // stays out of the engine's environment.
  const tokenFile = path.join(stateDir, "engine.token");
  writeFileSync(tokenFile, `${engineToken}\n`, { mode: 0o600 });
  const home = path.join(dir, "home");
  mkdirSync(path.join(home, ".ai-orchestrator"), { recursive: true });
  writeFileSync(
    path.join(home, ".ai-orchestrator", "config.json"),
    JSON.stringify({ serverPort }, null, 2),
  );

  // The engine reads its account folders from a folder of the stack's own,
  // not the server's mount, so in a project container the mock CLIs never
  // write into the host's live account folders.
  const configDir = path.join(dir, "engine-config");
  mkdirSync(configDir);
  writeFileSync(path.join(configDir, "account-dirs.json"), "{}\n");

  const engineEnv = childEnv({
    AIO_ENGINE_CONFIG_DIR: configDir,
    AIO_ENGINE_TOKEN_FILE: tokenFile,
    AIO_ENGINE_PORT: String(enginePort),
    AIO_PROJECT_ROOT: repo,
    AIO_CONTAINER: projectContainerName(projectId),
    AIO_ENGINE_VERSION: engineIdentity(),
    AIO_STATE_DIR: stateDir,
    AIO_PROJECT_ID: projectId,
    AIO_BUILD_SOCKET: path.join(stateDir, "build.sock"),
    ...options.engineEnv(dir),
  });
  const launchEngine = async () => {
    const proc = startProcess(ENGINE_MAIN, engineEnv);
    await waitFor("the engine to listen", () =>
      proc.output().includes("The engine is listening") ? true : undefined,
    );
    return proc;
  };
  let engine = await launchEngine();

  const server = startProcess(
    SERVER_MAIN,
    childEnv({
      AIO_HOME: home,
      AIO_ENGINE_VERSION: engineIdentity(),
      AIO_DEV_ENGINES: `${projectId}=127.0.0.1:${enginePort}:${engineToken}`,
    }),
  );
  const serverUrl = `https://127.0.0.1:${serverPort}`;
  await waitFor("the server to listen", () =>
    server.output().includes("listening on") ? true : undefined,
  );
  const serverToken = readFileSync(
    path.join(home, ".ai-orchestrator", "server.token"),
    "utf8",
  ).trim();
  // The CLI reads the token from server.token in the data directory, so it
  // stays out of the CLI's environment.
  const cliEnv = childEnv({
    AIO_SERVER: serverUrl,
    AIO_DATA_DIR: path.join(home, ".ai-orchestrator"),
  });
  // The server subscribes to the engine's event stream on its own.
  await waitFor("the server to subscribe to the engine", () =>
    subscriptions(engine) > 0 ? true : undefined,
  );

  return {
    dir,
    repo,
    projectId,
    stateDir,
    home,
    engineToken,
    engine: () => engine,
    server,
    cliEnv,
    async api(method, route, body) {
      // The server serves HTTPS; trust the certificate it wrote and nothing else.
      const cert = readFileSync(path.join(home, ".ai-orchestrator", "server.crt"), "utf8");
      const res = await pinnedFetch(() => pinFromPem(cert))(`${serverUrl}/api/v1${route}`, {
        method,
        headers: {
          authorization: `Bearer ${serverToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${text}`);
      return text === "" ? undefined : JSON.parse(text);
    },
    db() {
      return new Database(path.join(home, ".ai-orchestrator", "aio.db"), {
        readonly: true,
        fileMustExist: true,
      });
    },
    async restartEngine() {
      const old = engine;
      old.child.kill("SIGTERM");
      const code = await old.exited;
      if (code !== 0) throw new Error(`The engine exited ${String(code)}:\n${old.output()}`);
      engine = await launchEngine();
      await waitFor(
        "the server to subscribe to the new engine",
        () => (subscriptions(engine) > 0 ? true : undefined),
        30_000,
      );
    },
    close() {
      if (process.env.AIO_E2E_DEBUG === "1") {
        console.error(`--- server\n${server.output()}\n--- engine\n${engine.output()}`);
      }
      for (const p of [server, engine]) {
        if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
      }
      if (process.env.AIO_E2E_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
    },
  };
}
