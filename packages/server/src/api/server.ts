// The Fastify server: every route in the contracts' `serverRoutes` table,
// registered by iterating the table, plus the static apps and, on a plain
// HTTP listener, the dev-server proxy, which is told apart by its `Host`
// header.
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { existsSync } from "node:fs";
import {
  ClientHelloSchema,
  EVENT_TYPES,
  ServerStreamFrameSchema,
  TerminalClientMessageSchema,
  boxWorkDir,
  pathParamsSchema,
  projectContainerName,
  serverRoutes,
  type EventType,
  type HttpRouteDef,
  type WsRouteDef,
} from "@aio/contracts";
import type { TlsIdentity } from "@aio/contracts/tls";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type WebSocket from "ws";
import type { z } from "zod";
import { isAuthorized } from "./auth.js";
import type { ApiDeps } from "./deps.js";
import { ApiError, toApiError } from "./errors.js";
import { createHandlers, type HttpHandlers, type HttpRouteKey } from "./handlers.js";
import { attachCmd, shellCmd, sideSessionName } from "../terminals/attach.js";
import type { ExecRequest } from "../terminals/exec.js";
import { sendControl, serveTerminal } from "../terminals/terminal-socket.js";

interface RouteConfig {
  auth: boolean;
  ws: boolean;
}

declare module "fastify" {
  interface FastifyContextConfig {
    aio?: RouteConfig;
  }
}

/** Express-style path (`/a/:b`) as Fastify wants it; the formats match. */
function fastifyPath(path: string): string {
  return path;
}

function authInput(request: FastifyRequest) {
  return { authorization: request.headers.authorization, cookie: request.headers.cookie };
}

function sendFailure(reply: FastifyReply, failure: ApiError): FastifyReply {
  return reply.code(failure.status).send(failure.toBody());
}

/**
 * The failure to answer for an error that reached Fastify's error handler.
 * An error with a contract `code` keeps it, whatever else it carries; only
 * Fastify's own 4xx errors (a bad body, a missing route) map by `statusCode`.
 */
export function failureOf(err: unknown): ApiError {
  const failure = toApiError(err);
  if (failure.code !== "internal" || err instanceof ApiError) return failure;
  const status = (err as { statusCode?: number }).statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    return new ApiError(
      status === 404 ? "not_found" : status === 401 ? "unauthorized" : "validation",
      (err as Error).message,
      undefined,
      status,
    );
  }
  return failure;
}

export interface ApiServer {
  app: FastifyInstance;
  /** Starts listening on 127.0.0.1; resolves with the bound port. */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** The loopback names a page of the server's own origin can use. */
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/**
 * True when a WebSocket upgrade may proceed: it carries no `Origin`, as from
 * the CLI or an Electron main process, or its `Origin` is this listener's
 * own, with its scheme and the port the request arrived on. A page on
 * another port or host can't open the server's sockets with the user's
 * cookie.
 */
export function isOwnOrigin(origin: string | undefined, secure: boolean, port: number): boolean {
  if (origin === undefined) return true;
  const scheme = secure ? "https" : "http";
  return LOOPBACK_NAMES.some((name) => origin.toLowerCase() === `${scheme}://${name}:${port}`);
}

/**
 * Builds the API server. With `tls`, it serves HTTPS with that key and
 * certificate, and the dev-server proxy stays off this listener: the proxy's
 * `*.localhost` names aren't in the certificate, so `startApp` gives the
 * proxy a plain HTTP listener of its own.
 */
export async function createApiServer(deps: ApiDeps & { tls?: TlsIdentity }): Promise<ApiServer> {
  const tls = deps.tls;
  const proxy = tls ? undefined : deps.proxy;
  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    serverFactory: (handler) => {
      const listener: http.RequestListener = (req, res) => {
        if (proxy?.matches(req)) void proxy.handleRequest(req, res);
        else handler(req, res);
      };
      const server: http.Server = tls
        ? https.createServer({ key: tls.key, cert: tls.cert }, listener)
        : http.createServer(listener);
      // Divert proxy-host upgrades before @fastify/websocket sees them.
      const emit = server.emit.bind(server) as (event: string, ...args: unknown[]) => boolean;
      server.emit = ((event: string, ...args: unknown[]) => {
        if (event === "upgrade" && proxy?.matches(args[0] as http.IncomingMessage)) {
          const [req, socket, head] = args as [http.IncomingMessage, Duplex, Buffer];
          void proxy.handleUpgrade(req, socket, head);
          return true;
        }
        return emit(event, ...args);
      }) as typeof server.emit;
      return server;
    },
  });

  // An empty JSON body parses as `undefined`, for routes with an optional body.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError("validation", "The body is not valid JSON."), undefined);
    }
  });

  app.setErrorHandler((err, _request, reply) => {
    const failure = failureOf(err);
    if (failure.status >= 500 && failure.code !== "docker_unavailable")
      deps.log?.(`Request failed: ${failure.message}`);
    return sendFailure(reply, failure);
  });
  app.setNotFoundHandler((request, reply) =>
    sendFailure(reply, new ApiError("not_found", `No route for ${request.method} ${request.url}.`)),
  );

  app.addHook("onRequest", async (request, reply) => {
    const config = request.routeOptions.config.aio;
    const port = request.socket.localPort ?? 0;
    if (config?.ws && !isOwnOrigin(request.headers.origin, tls !== undefined, port)) {
      reply.header("connection", "close");
      return sendFailure(
        reply,
        new ApiError("unauthorized", "The upgrade came from another origin.", undefined, 403),
      );
    }
    if (!config?.auth) return;
    if (!isAuthorized(authInput(request), deps.token)) {
      // A refused upgrade leaves no HTTP connection worth keeping.
      if (config.ws) reply.header("connection", "close");
      return sendFailure(reply, new ApiError("unauthorized", "Missing or wrong bearer token."));
    }
  });

  // An upgrade request answered with a plain HTTP response keeps a detached
  // socket that the server no longer tracks, so close it here.
  app.addHook("onResponse", async (request, reply) => {
    if (request.headers.upgrade && reply.statusCode !== 101) request.raw.socket?.destroy();
  });

  await app.register(fastifyWebsocket);

  const handlers = createHandlers(deps);
  for (const [key, def] of Object.entries(serverRoutes)) {
    if (def.kind === "http") registerHttp(app, key as HttpRouteKey, def, handlers);
  }
  registerWs(app, serverRoutes["events.stream"], (socket, request) =>
    serveEvents(deps, socket, request),
  );
  registerWs(app, serverRoutes["terminals.open"], (socket, request) =>
    serveTerminalRoute(deps, socket, request),
  );
  registerWs(app, serverRoutes["jobs.stream"], (socket, request) =>
    serveJob(deps, socket, request),
  );

  const dirs = deps.staticDirs ?? {};
  let decorated = false;
  for (const [prefix, root] of [
    ["/boxes/", dirs.boxes],
    ["/review/", dirs.review],
  ] as const) {
    if (root && existsSync(root)) {
      await app.register(fastifyStatic, {
        root,
        prefix,
        decorateReply: !decorated,
        index: "index.html",
      });
      decorated = true;
    }
  }

  return {
    app,
    async listen(port, host = "127.0.0.1") {
      await app.listen({ port, host });
      const address = app.server.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async close() {
      proxy?.close();
      for (const client of app.websocketServer.clients) client.terminate();
      await app.close();
    },
  };
}

function registerHttp(
  app: FastifyInstance,
  key: HttpRouteKey,
  def: HttpRouteDef,
  handlers: HttpHandlers,
): void {
  const params = pathParamsSchema(def.path);
  const handler = handlers[key] as (ctx: unknown) => Promise<unknown>;
  app.route({
    method: def.method,
    url: fastifyPath(def.path),
    config: { aio: { auth: def.auth, ws: false } },
    handler: async (request, reply) => {
      const ctx = {
        params: parse(params, request.params, "path"),
        query: def.query ? parse(def.query, request.query ?? {}, "query") : undefined,
        body: def.body ? parse(def.body, request.body, "body", ownRouteHint(key)) : undefined,
        request,
        reply,
      };
      const result = await handler(ctx);
      const checked = def.response.safeParse(result);
      if (!checked.success) {
        throw new ApiError(
          "internal",
          `The server built an invalid response for ${key}.`,
          checked.error.issues,
        );
      }
      if (reply.statusCode === 200 && def.status) reply.code(def.status);
      return reply.send(checked.data);
    },
  });
}

function parse(
  schema: z.ZodTypeAny,
  value: unknown,
  where: string,
  hint?: (issues: z.ZodIssue[]) => string | undefined,
): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    const extra = hint?.(result.error.issues);
    throw new ApiError(
      "validation",
      `The ${where} doesn't match its schema.${extra ? ` ${extra}` : ""}`,
      result.error.issues,
    );
  }
  return result.data;
}

/**
 * Settings fields that `PATCH /api/v1/settings` refuses because another route
 * owns them, with that route. The schema rejects them as unrecognized keys;
 * the hint tells the caller where to send them instead.
 */
export const SETTINGS_KEYS_WITH_OWN_ROUTE: Readonly<Record<string, string>> = {
  secretRefs: "PUT /api/v1/secrets",
  globalMounts: "PUT /api/v1/global-mounts",
  promptTemplates: "PUT /api/v1/prompts",
};

/** Returns the body hint for a route, or undefined when it has none. */
function ownRouteHint(
  key: HttpRouteKey,
): ((issues: z.ZodIssue[]) => string | undefined) | undefined {
  return key === "settings.patch" ? settingsPatchHint : undefined;
}

/**
 * Names the route to use for each settings field in `issues` that has its own
 * route, or returns undefined when none of them does.
 */
export function settingsPatchHint(issues: z.ZodIssue[]): string | undefined {
  const hints: string[] = [];
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys" || issue.path.length > 0) continue;
    for (const k of issue.keys) {
      const route = SETTINGS_KEYS_WITH_OWN_ROUTE[k];
      if (route) hints.push(`Set ${k} with ${route}.`);
    }
  }
  return hints.length > 0 ? hints.join(" ") : undefined;
}

function registerWs(
  app: FastifyInstance,
  def: WsRouteDef,
  handler: (socket: WebSocket, request: FastifyRequest) => void | Promise<void>,
): void {
  app.route({
    method: "GET",
    url: fastifyPath(def.path),
    config: { aio: { auth: def.auth, ws: true } },
    handler: (_request, reply) =>
      sendFailure(
        reply,
        new ApiError("validation", "This route needs a WebSocket upgrade.", undefined, 426),
      ),
    wsHandler: (socket, request) => {
      void Promise.resolve(handler(socket, request)).catch(() => socket.close(1011));
    },
  });
}

// ---------------------------------------------------------------------------
// events.stream

const QUERY_TYPES = new Set<string>(EVENT_TYPES);

/** Parses the `types` query: a comma-separated list, or all when absent. */
export function parseTypes(types: string | undefined): Set<EventType> | null {
  if (types === undefined || types.trim() === "") return null;
  const list = types
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const unknown = list.filter((t) => !QUERY_TYPES.has(t));
  if (unknown.length)
    throw new ApiError("validation", `Unknown event types: ${unknown.join(", ")}.`);
  return new Set(list as EventType[]);
}

function serveEvents(deps: ApiDeps, socket: WebSocket, request: FastifyRequest): void {
  let types: Set<EventType> | null;
  try {
    const query = serverRoutes["events.stream"].query.parse(request.query ?? {});
    types = parseTypes(query.types);
  } catch (err) {
    socket.close(1008, toApiError(err).message.slice(0, 120));
    return;
  }
  // `sentUpTo` is the hub `seq` this socket has caught up to. A filtered
  // socket numbers what it sends by counting on from its hello's `lastSeq`,
  // so its stream has no gaps where the other types were.
  let sentUpTo: number | null = null;
  let streamId = deps.hub.streamId;
  let position = 0;
  const send = (frame: unknown) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(ServerStreamFrameSchema.parse(frame)));
    }
  };
  const unsubscribe = deps.hub.subscribe((event) => {
    if (sentUpTo === null || event.seq <= sentUpTo) return;
    if (event.seq !== sentUpTo + 1) {
      // The hub delivers every event in order, so this socket missed one. A
      // filtered socket counts its own positions and would hide the loss, so
      // close instead: the client reconnects and the replay fills it in.
      sentUpTo = null;
      socket.close(1011, "The event stream skipped an event; reconnect to resume.");
      return;
    }
    sentUpTo = event.seq;
    if (types === null) {
      send(event);
    } else if (types.has(event.type)) {
      position += 1;
      send({ ...event, streamId, seq: position });
    }
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      socket.close(1003, "Event streams carry JSON text frames only.");
      return;
    }
    let hello;
    try {
      hello = ClientHelloSchema.parse(JSON.parse(data.toString()));
    } catch {
      socket.close(1008, "The frame is not a hello.");
      return;
    }
    // Replay and subscription run in one tick, so no event falls between them.
    const plan = deps.hub.replay(hello, types);
    send(plan.hello);
    for (const event of plan.events) send(event);
    streamId = plan.hello.streamId;
    position = plan.hello.lastSeq;
    sentUpTo = deps.hub.lastSeq;
  });
  socket.on("close", unsubscribe);
}

// ---------------------------------------------------------------------------
// terminals.open

/** Turns a terminal query into the exec to run. */
export async function resolveTerminal(
  deps: Pick<ApiDeps, "core">,
  query: z.output<(typeof serverRoutes)["terminals.open"]["query"]>,
): Promise<ExecRequest & { boxId: string | null }> {
  const size = { cols: query.cols, rows: query.rows };
  if (query.boxId !== undefined) {
    const view = await deps.core.boxes.get(query.boxId);
    if (query.kind === "shell") {
      return {
        container: view.container,
        cmd: shellCmd(),
        workingDir: boxWorkDir(view.box),
        boxId: view.box.id,
        ...size,
      };
    }
    const session =
      query.kind === "side" && query.platform
        ? sideSessionName(view.tmuxSession, query.platform)
        : view.tmuxSession;
    return { container: view.container, cmd: attachCmd(session), boxId: view.box.id, ...size };
  }
  const summary = await deps.core.projects.get(query.projectId as string);
  return {
    container: summary.container?.name ?? projectContainerName(summary.project.id),
    cmd: shellCmd(),
    workingDir: summary.project.root,
    boxId: null,
    ...size,
  };
}

async function serveTerminalRoute(deps: ApiDeps, socket: WebSocket, request: FastifyRequest) {
  let target;
  let kind: "session" | "side" | "shell";
  try {
    const query = serverRoutes["terminals.open"].query.parse(request.query ?? {});
    kind = query.kind;
    target = await resolveTerminal(deps, query);
  } catch (err) {
    sendControl(socket, { type: "error", error: toApiError(err).toBody().error });
    socket.close(1008, "bad terminal request");
    return;
  }
  const end = await serveTerminal(socket, deps.exec, target);
  // Only the container monitor reports a session that ended unexpectedly,
  // once per session end; a closing tab never does.
  deps.hub.emit({
    type: "terminal.ended",
    terminalId: end.terminalId,
    boxId: target.boxId,
    kind,
    exitCode: end.exitCode,
    unexpected: false,
  });
}

// ---------------------------------------------------------------------------
// jobs.stream

function serveJob(deps: ApiDeps, socket: WebSocket, request: FastifyRequest): void {
  const jobId = (request.params as { jobId?: string }).jobId ?? "";
  const attachment = deps.jobs.attach(jobId);
  if (!attachment) {
    sendControl(socket, {
      type: "error",
      error: { code: "not_found", message: `No job has the id ${jobId}.` },
    });
    socket.close(1008, "unknown job");
    return;
  }
  sendControl(socket, { type: "ready", terminalId: jobId });
  if (attachment.backlog.length > 0) socket.send(attachment.backlog, { binary: true });
  attachment.onData((chunk) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
  });
  attachment.onDone((job) => {
    sendControl(socket, { type: "exit", exitCode: job.exitCode });
    socket.close(1000, "finished");
  });
  socket.on("message", (data, isBinary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary) return attachment.write(buf);
    const parsed = TerminalClientMessageSchema.safeParse(
      (() => {
        try {
          return JSON.parse(buf.toString());
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success) return;
    if (parsed.data.type === "resize") attachment.resize(parsed.data.cols, parsed.data.rows);
    else attachment.write(Buffer.from(parsed.data.data));
  });
  socket.on("close", () => attachment.detach());
}
