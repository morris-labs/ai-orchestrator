// The `aio-secret` command: gets secrets from the broker for agents and
// tools in a project container, so values reach only the process that needs
// them instead of every process's environment.
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { BrokerClient, BrokerError, type BrokerClientErrorCode } from "./broker-client.js";

export const SECRET_USAGE = `Usage:
  aio-secret NAME
  aio-secret get NAME
  aio-secret run NAME[,NAME...] [NAME...] -- COMMAND [ARGS...]
  aio-secret list

Gets the project's secrets from the AI Orchestrator secrets broker.

Commands:
  get NAME   Print the value of NAME, without a trailing newline. "get" is
             optional.
  run        Run COMMAND with the named secrets added to its environment.
             The values reach COMMAND and its children only.
  list       Print the names this container can request, one per line.

Exit status: 0 on success, 2 for a usage error, 3 when the broker can't be
reached, 4 for a name the project doesn't list, 5 when 1Password is locked
or a reference doesn't resolve, and 1 for any other failure. With run, the
status of COMMAND.
`;

/** The exit status for each broker failure. */
export const EXIT_CODES: Record<BrokerClientErrorCode, number> = {
  unreachable: 3,
  unsupported: 3,
  protocol: 3,
  not_found: 4,
  secrets_locked: 5,
  secrets_unavailable: 5,
  run_not_found: 1,
  conflict: 1,
  engine_mismatch: 1,
  validation: 1,
  internal: 1,
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** The broker to ask. Default: a `BrokerClient` for `env`. */
  client?: Pick<BrokerClient, "names" | "read">;
  /** Runs COMMAND with `env` and returns its exit status. Default: `execOrSpawn`. */
  run?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}

export type SecretCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "get"; name: string }
  | { kind: "run"; names: string[]; command: string; args: string[] };

/** Parses the arguments; throws an `Error` whose message explains a usage error. */
export function parseSecretArgs(argv: readonly string[]): SecretCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    if (first === undefined) throw new Error("Name a secret or a command.");
    return { kind: "help" };
  }
  if (first === "list") {
    if (rest.length > 0) throw new Error("list takes no arguments.");
    return { kind: "list" };
  }
  if (first === "run") {
    const dashes = rest.indexOf("--");
    if (dashes < 0) throw new Error("run needs -- before the command.");
    const names = rest
      .slice(0, dashes)
      .flatMap((a) => a.split(","))
      .filter((n) => n !== "");
    const [command, ...args] = rest.slice(dashes + 1);
    if (names.length === 0) throw new Error("run needs at least one secret name.");
    if (command === undefined) throw new Error("run needs a command after --.");
    for (const n of names) checkName(n);
    return { kind: "run", names, command, args };
  }
  const name = first === "get" ? rest[0] : first;
  const extra = first === "get" ? rest.slice(1) : rest;
  if (name === undefined) throw new Error("get needs a secret name.");
  if (extra.length > 0) throw new Error("get takes one secret name.");
  checkName(name);
  return { kind: "get", name };
}

function checkName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(`${name} isn't a valid secret name: use letters, digits, and underscores.`);
  }
}

/** The program that started this one, by its short name, for the broker's log. */
function parentName(): string | null {
  try {
    return readFileSync(`/proc/${process.ppid}/comm`, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The command's path: as given when it has a slash, else the first match on `PATH`. */
export function resolveCommand(command: string, pathVar: string | undefined): string | null {
  if (command.includes("/")) return command;
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next directory.
    }
  }
  return null;
}

/**
 * Replaces this process with the command when Node has `process.execve`, so
 * no Node process stays around holding the values; otherwise starts it as a
 * child and passes signals on. Returns the exit status in the second case.
 */
export async function execOrSpawn(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const file = resolveCommand(command, env.PATH);
  if (file === null) throw new Error(`${command}: command not found`);
  if (typeof process.execve === "function") {
    process.execve(file, [command, ...args], env);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: "inherit", argv0: command });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const s of signals) process.on(s, forward);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      for (const s of signals) process.off(s, forward);
      resolve(code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0));
    });
  });
}

/** Runs `aio-secret` and returns its exit status. */
export async function secretMain(argv: readonly string[], io: SecretCliIo): Promise<number> {
  let parsed: SecretCommand;
  try {
    parsed = parseSecretArgs(argv);
  } catch (err) {
    io.stderr(`aio-secret: ${(err as Error).message}\n\n${SECRET_USAGE}`);
    return 2;
  }
  if (parsed.kind === "help") {
    io.stdout(SECRET_USAGE);
    return 0;
  }
  const parent = parentName();
  const from = parent ? ` (from ${parent})` : "";
  try {
    const client = io.client ?? new BrokerClient({ env: io.env });
    if (parsed.kind === "list") {
      const names = await client.names();
      io.stdout(names.map((n) => `${n}\n`).join(""));
      return 0;
    }
    if (parsed.kind === "get") {
      const values = await client.read([parsed.name], `aio-secret get${from}`);
      io.stdout(values[parsed.name]!);
      return 0;
    }
    // Only the program's name goes to the log: its arguments could hold anything.
    const values = await client.read(parsed.names, `aio-secret run ${parsed.command}${from}`);
    const env: NodeJS.ProcessEnv = { ...io.env, ...values };
    return await (io.run ?? execOrSpawn)(parsed.command, parsed.args, env);
  } catch (err) {
    if (err instanceof BrokerError) {
      io.stderr(`aio-secret: ${err.message}\n`);
      return EXIT_CODES[err.code];
    }
    io.stderr(`aio-secret: ${(err as Error).message}\n`);
    return parsed.kind === "run" ? 127 : 1;
  }
}
