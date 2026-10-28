// Starts the built engine and server as local processes and runs the built
// `agentbox` CLI against them.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const ENGINE_MAIN = path.join(ROOT, "packages/engine/dist/main.js");
export const SERVER_MAIN = path.join(ROOT, "packages/server/dist/main.js");
export const CLI_MAIN = path.join(ROOT, "packages/cli/dist/main.js");
export const SAMPLE_BUILD = path.join(ROOT, "tools/sample-repo/build.sh");

/** Throws when a package the suite runs has not been built. */
export function requireBuilt(): void {
  for (const file of [ENGINE_MAIN, SERVER_MAIN, CLI_MAIN]) {
    if (!existsSync(file)) {
      throw new Error(`${file} is missing. Run corepack pnpm -r build first.`);
    }
  }
}

/**
 * The environment for a child process: this one's plus `extra`, without
 * `TMUX`, so that nothing a child runs can reach the tmux server of the box
 * the suite runs in, and without any `AGENTBOX_` variable the suite didn't set.
 */
export function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["TMUX", "TMUX_PANE", "AGENTBOX_SERVER", "AGENTBOX_TOKEN"]) delete env[name];
  for (const name of Object.keys(env)) if (name.startsWith("AGENTBOX_")) delete env[name];
  return { ...env, ...extra };
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("No port was assigned."));
      });
    });
  });
}

/** The server's project id for a root: `slug(basename)-<8 hex digits of sha1(root)>`. */
export function projectIdForRoot(root: string): string {
  const hash = createHash("sha1").update(root, "utf8").digest("hex").slice(0, 8);
  const slug = path.posix
    .basename(root)
    .replace(/[^0-9A-Za-z]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "project"}-${hash}`;
}

/** A child process with its combined output and its exit. */
export interface Proc {
  child: ChildProcess;
  output(): string;
  /** Resolves with the exit code, or with `null` when a signal ended it. */
  exited: Promise<number | null>;
}

export function startProcess(file: string, env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, [file], { env, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout?.on("data", (d: Buffer) => (text += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (text += d.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  return { child, output: () => text, exited };
}

/** Calls `check` until it returns a value other than `undefined`, or throws on timeout. */
export async function waitFor<T>(
  what: string,
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() > until) {
      throw new Error(
        `Timed out waiting for ${what}${last ? `: ${(last as Error).message}` : "."}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built `agentbox` CLI to completion. */
export function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI_MAIN, ...args], { env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Runs the CLI with `--json` and parses its output; throws on a non-zero exit. */
export async function cliJson<T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> {
  const r = await runCli(["--json", ...args], env);
  if (r.code !== 0) throw new Error(`agentbox ${args.join(" ")} exited ${r.code}: ${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

/**
 * Starts `agentbox events` in the background and resolves `connected` once
 * the server's hello line arrives, so no later event is missed.
 */
export function tailEvents(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [CLI_MAIN, "events", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const lines = () =>
    stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const connected = waitFor("the event stream hello", () =>
    lines().some((l) => l.type === "hello") ? true : undefined,
  );
  return { child, exited, lines, stderr: () => stderr, connected };
}
