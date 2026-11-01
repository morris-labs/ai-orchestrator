// The secrets broker: one Unix socket per project container, in a host
// directory that the container mounts read-only at `BROKER_MOUNT`. A process
// in the container asks the socket for the secrets its project lists; the
// broker resolves them through the secrets service, which caches them for a
// few minutes. Values never appear in a log line; the log records the
// container, the names, the caller's own description, and the outcome.
//
// The socket identifies the container and nothing finer: every process in
// the container runs as the same user and can ask for any listed secret.
//
// Under Docker Desktop a host socket can't be mounted into a container, so
// the broker listens on 127.0.0.1 instead, on one port per container, and
// requires the bearer token it writes to `broker.token` in the same mounted
// directory. Any process on the host can connect to a loopback port, so the
// token, not the port, identifies the container. See `docs/secrets.md`.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  BROKER_MAX_BODY_BYTES,
  BROKER_ROUTES,
  BROKER_SOCKET_NAME,
  BROKER_TCP_BIND,
  BROKER_TOKEN_NAME,
  BROKER_URL_NAME,
  BrokerErrorCodeSchema,
  brokerTcpUrl,
  BrokerReadRequestSchema,
  type BrokerErrorCode,
} from "@aio/contracts";
import { ApiError, STATUS_BY_CODE, toApiError } from "../api/errors.js";

/** Where the broker gets names and values for a project. */
export interface BrokerSource {
  /** The names the project's containers may request. */
  names(projectId: string): Promise<string[]>;
  /** The values of `names`; throws an `ApiError` such as `not_found` or `secrets_locked`. */
  read(projectId: string, names: readonly string[]): Promise<Record<string, string>>;
}

/** A project container the broker serves. */
export interface BrokerTarget {
  container: string;
  projectId: string;
  /**
   * The host port of the TCP transport. Absent means the Unix socket. The
   * broker binds it on `BROKER_TCP_BIND` only.
   */
  tcpPort?: number;
}

export interface BrokerOpenOptions {
  /**
   * Writes a new token for a TCP target even when one exists. The server
   * asks for it each time it creates the container, so a token never
   * outlives its container. Without it, a restarted server keeps the token
   * that the running container already reads.
   */
  rotateToken?: boolean;
}

export interface SecretsBrokerOptions {
  source: BrokerSource;
  /** The host directory that holds a container's socket. */
  dirFor: (container: string) => string;
  log: (message: string) => void;
  /**
   * How long `sync` leaves a socket open for a container it doesn't list.
   * A container opens its socket before it exists, so a sync that runs
   * meanwhile mustn't close it. Default: 2 minutes.
   */
  closeGraceMs?: number;
  /** The clock in milliseconds; tests replace it. Default: `Date.now`. */
  now?: () => number;
}

/**
 * The longest Unix socket path Linux accepts, in bytes: `sun_path` holds
 * 108 bytes with the terminating null.
 */
export const MAX_SOCKET_PATH_BYTES = 107;

/**
 * Throws when `socketPath` is too long for a Unix socket. The broker's
 * directory names have a fixed length (see `brokerDirName`), so only the
 * data directory's own path can make it too long; the message says so and
 * how much to cut.
 */
export function assertSocketPathFits(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes <= MAX_SOCKET_PATH_BYTES) return;
  throw new ApiError(
    "internal",
    `The secrets broker socket path ${socketPath} is ${bytes} bytes, and a Unix socket path ` +
      `can be at most ${MAX_SOCKET_PATH_BYTES}. Choose a data directory (--data-dir or ` +
      `AIO_DATA_DIR) whose path is at least ${bytes - MAX_SOCKET_PATH_BYTES} bytes shorter.`,
  );
}

/** How often the server matches the open sockets to the running containers. */
export const BROKER_SYNC_INTERVAL_MS = 30_000;

/** The bearer token check of a TCP listener; `null` for a Unix socket. */
interface TokenCheck {
  /** The SHA-256 of the token, so the comparison takes the same time for any input. */
  digest: Buffer;
}

interface OpenSocket {
  projectId: string;
  server: http.Server;
  openedAt: number;
  /** The socket path, or `null` for TCP. */
  socketPath: string | null;
  /** The TCP port, or `null` for the Unix socket. */
  tcpPort: number | null;
  auth: TokenCheck | null;
}

/** A new random token: 32 bytes as hex. */
export function newBrokerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function digestOf(text: string): Buffer {
  return crypto.createHash("sha256").update(text, "utf8").digest();
}

/**
 * Whether an `Authorization` header carries `expected`'s token. Hashes both
 * sides and compares the digests with `timingSafeEqual`, so neither the
 * length nor the content of a wrong token changes how long it takes.
 */
export function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
  const given = digestOf(m?.[1] ?? "");
  // Compared even without a token, so a missing header costs the same.
  return crypto.timingSafeEqual(given, expected) && m !== null;
}

/** Writes `content` to `file` with mode 0600, replacing it atomically. */
function writePrivate(file: string, content: string): void {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Makes caller text safe for one log line: no control characters, at most 200 characters. */
export function logSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 200)}...` : clean;
}

export class SecretsBroker {
  private readonly sockets = new Map<string, OpenSocket>();
  /** Opens in flight, so two callers for one container share one listen. */
  private readonly opening = new Map<string, Promise<void>>();

  constructor(private readonly opts: SecretsBrokerOptions) {}

  /** The socket path on the host for a container. */
  socketPath(container: string): string {
    return path.join(this.opts.dirFor(container), BROKER_SOCKET_NAME);
  }

  /** The token file path on the host for a container. */
  tokenPath(container: string): string {
    return path.join(this.opts.dirFor(container), BROKER_TOKEN_NAME);
  }

  /** The TCP port the broker listens on for a container, or `null`. */
  tcpPort(container: string): number | null {
    return this.sockets.get(container)?.tcpPort ?? null;
  }

  /** The containers with an open socket. */
  openContainers(): string[] {
    return [...this.sockets.keys()].sort();
  }

  /**
   * Listens on the container's socket, replacing whatever file is at its
   * path, or with `tcpPort`, on that port of 127.0.0.1. Does nothing when
   * the same listener is already open for the same project, except that
   * `rotateToken` still writes a new token. Throws `internal` when the path
   * is too long for a Unix socket or the port is taken.
   */
  async open(target: BrokerTarget, options: BrokerOpenOptions = {}): Promise<void> {
    const pending = this.opening.get(target.container);
    if (pending) await pending.catch(() => undefined);
    const current = this.sockets.get(target.container);
    if (
      current?.projectId === target.projectId &&
      current.tcpPort === (target.tcpPort ?? null) &&
      current.server.listening
    ) {
      // A container about to be created again gets the full grace period.
      current.openedAt = this.now();
      if (options.rotateToken && current.auth) {
        current.auth.digest = this.writeToken(target.container, true);
      }
      return;
    }
    const work = (async () => {
      if (current) await this.close(target.container);
      if (target.tcpPort === undefined) await this.listen(target);
      else await this.listenTcp(target, target.tcpPort, options.rotateToken ?? false);
    })();
    this.opening.set(target.container, work);
    try {
      await work;
    } finally {
      if (this.opening.get(target.container) === work) this.opening.delete(target.container);
    }
  }

  private async listen(target: BrokerTarget): Promise<void> {
    const dir = this.opts.dirFor(target.container);
    const socketPath = this.socketPath(target.container);
    assertSocketPathFits(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // A socket left by an earlier server, or anything else at the path. Only
    // the host user can write here: the container mounts it read-only.
    fs.rmSync(socketPath, { recursive: true, force: true });
    // A container once created with TCP left these. The client prefers the
    // URL file to the default socket, so it must go.
    fs.rmSync(path.join(dir, BROKER_URL_NAME), { force: true });
    fs.rmSync(path.join(dir, BROKER_TOKEN_NAME), { force: true });
    const server = http.createServer((req, res) => {
      void this.handle(target, req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
    server.on("error", (err) =>
      this.opts.log(`Secrets broker: ${target.container} socket failed: ${err.message}`),
    );
    this.sockets.set(target.container, {
      projectId: target.projectId,
      server,
      socketPath,
      tcpPort: null,
      auth: null,
      openedAt: this.now(),
    });
  }

  /**
   * Returns the digest of the container's token, writing a new one when
   * `rotate` is set or the file holds no valid token.
   */
  private writeToken(container: string, rotate: boolean): Buffer {
    const file = this.tokenPath(container);
    if (!rotate) {
      let existing = "";
      try {
        existing = fs.readFileSync(file, "utf8").trim();
      } catch {
        // None yet.
      }
      if (TOKEN_PATTERN.test(existing)) {
        fs.chmodSync(file, 0o600);
        return digestOf(existing);
      }
    }
    const token = newBrokerToken();
    writePrivate(file, `${token}\n`);
    return digestOf(token);
  }

  private async listenTcp(target: BrokerTarget, port: number, rotate: boolean): Promise<void> {
    const dir = this.opts.dirFor(target.container);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // A socket from when the container used the Unix transport.
    fs.rmSync(this.socketPath(target.container), { recursive: true, force: true });
    const auth: TokenCheck = { digest: this.writeToken(target.container, rotate) };
    writePrivate(path.join(dir, BROKER_URL_NAME), `${brokerTcpUrl(port)}\n`);
    const server = http.createServer((req, res) => {
      void this.handle(target, req, res, auth);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host: BROKER_TCP_BIND, exclusive: true }, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (err) {
      throw new ApiError(
        "internal",
        `The secrets broker can't listen on ${BROKER_TCP_BIND}:${port} for ${target.container}: ` +
          `${(err as Error).message}`,
      );
    }
    server.on("error", (err) =>
      this.opts.log(`Secrets broker: ${target.container} listener failed: ${err.message}`),
    );
    this.sockets.set(target.container, {
      projectId: target.projectId,
      server,
      socketPath: null,
      tcpPort: port,
      auth,
      openedAt: this.now(),
    });
  }

  /**
   * Stops listening for a container and removes its socket file; the
   * directory stays. A TCP listener's token and URL files stay too, so a
   * restarted server opens the same port with the token the running
   * container already reads.
   */
  async close(container: string): Promise<void> {
    const open = this.sockets.get(container);
    if (!open) return;
    this.sockets.delete(container);
    await new Promise<void>((resolve) => {
      open.server.close(() => resolve());
      open.server.closeAllConnections();
    });
    if (open.socketPath !== null) fs.rmSync(open.socketPath, { force: true });
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Opens a socket for each target that lacks one and closes the sockets of
   * containers not in the list, once they're older than the grace period. A
   * failure for one container is logged and doesn't stop the others.
   */
  async sync(targets: readonly BrokerTarget[]): Promise<void> {
    const wanted = new Set(targets.map((t) => t.container));
    const grace = this.opts.closeGraceMs ?? 120_000;
    for (const [container, open] of [...this.sockets]) {
      if (!wanted.has(container) && this.now() - open.openedAt >= grace) {
        await this.close(container);
      }
    }
    for (const target of targets) {
      try {
        await this.open(target);
      } catch (err) {
        const what = target.tcpPort === undefined ? "socket" : "TCP listener";
        this.opts.log(
          `Secrets broker: can't open the ${what} for ${target.container}: ${(err as Error).message}`,
        );
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const container of [...this.sockets.keys()]) await this.close(container);
  }

  private async handle(
    target: BrokerTarget,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auth: TokenCheck | null = null,
  ): Promise<void> {
    const route = (req.url ?? "").split("?")[0];
    let kind = `${req.method ?? "?"} ${route}`;
    let names: string[] = [];
    let caller = "";
    if (auth && !bearerMatches(req.headers.authorization, auth.digest)) {
      // Neither the header nor the body is read or logged: either could hold
      // a secret that a wrong client sent here.
      const why = req.headers.authorization === undefined ? "missing token" : "wrong token";
      this.opts.log(`Secrets broker: ${target.container} ${logSafe(kind)}: unauthorized (${why})`);
      req.resume();
      send(res, STATUS_BY_CODE.unauthorized, {
        error: { code: "unauthorized", message: "The secrets broker needs the container's token." },
      });
      return;
    }
    try {
      if (req.method === "GET" && route === BROKER_ROUTES.names) {
        kind = "list";
        send(res, 200, { names: await this.opts.source.names(target.projectId) });
      } else if (req.method === "POST" && route === BROKER_ROUTES.read) {
        kind = "read";
        const body = BrokerReadRequestSchema.parse(JSON.parse(await readBody(req)));
        names = [...new Set(body.names)];
        caller = body.caller ?? "";
        const values = await this.opts.source.read(target.projectId, names);
        send(res, 200, { values });
      } else {
        throw new ApiError("not_found", `The secrets broker has no route ${kind}.`);
      }
      this.logRequest(target.container, kind, names, caller, "ok");
    } catch (err) {
      const apiError = err instanceof SyntaxError ? badJson() : toApiError(err);
      const code: BrokerErrorCode = BrokerErrorCodeSchema.safeParse(apiError.code).success
        ? (apiError.code as BrokerErrorCode)
        : "internal";
      this.logRequest(target.container, kind, names, caller, code);
      send(res, STATUS_BY_CODE[code], { error: { code, message: apiError.message } });
    }
  }

  private logRequest(
    container: string,
    kind: string,
    names: readonly string[],
    caller: string,
    outcome: string,
  ): void {
    const what = names.length > 0 ? ` ${names.join(",")}` : "";
    const who = caller ? ` for "${logSafe(caller)}"` : "";
    this.opts.log(`Secrets broker: ${container} ${kind}${what}${who}: ${outcome}`);
  }
}

function badJson(): ApiError {
  return new ApiError("validation", "The request body isn't valid JSON.");
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/** Reads a request body of at most `BROKER_MAX_BODY_BYTES`; throws `validation` beyond that. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Past the limit the rest is read and dropped, so the answer still
    // reaches the client.
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BROKER_MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > BROKER_MAX_BODY_BYTES) {
        reject(new ApiError("validation", "The request body is too large."));
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}
