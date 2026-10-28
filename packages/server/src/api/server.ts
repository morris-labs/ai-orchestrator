// The Fastify server: every route in the contracts' `serverRoutes` table,
// registered by iterating the table, plus the static apps and the dev-server
// proxy, which shares the listener and is told apart by its `Host` header.
import http from "node:http";
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
  type AgentBoxEvent,
  type EventType,
  type HttpRouteDef,
  type WsRouteDef,
} from "@agentbox/contracts";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type WebSocket from "ws";
import type { z } from "zod";
import { isAuthorized } from "./auth.js";
import type { ApiDeps } from "./deps.js";
import { ApiFailure, toApiFailure } from "./errors.js";
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
    agentbox?: RouteConfig;
  }
}

/** Express-style path (`/a/:b`) as Fastify wants it; the formats match. */
function fastifyPath(path: string): string {
  return path;
}

function authInput(request: FastifyRequest, ws: boolean) {
  const query = request.query as Record<string, unknown> | undefined;
  return {
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    queryToken: ws && typeof query?.token === "string" ? query.token : undefined,
  };
}

function sendFailure(reply: FastifyReply, failure: ApiFailure): FastifyReply {
  return reply.code(failure.status).send(failure.toBody());
}

export interface ApiServer {
  app: FastifyInstance;
  /** Starts listening on 127.0.0.1; resolves with the bound port. */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export async function createApiServer(deps: ApiDeps): Promise<ApiServer> {
  const proxy = deps.proxy;
  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    serverFactory: (handler) => {
      const server = http.createServer((req, res) => {
        if (proxy?.matches(req)) void proxy.handleRequest(req, res);
        else handler(req, res);
      });
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
      done(new ApiFailure("validation", "The body is not valid JSON."), undefined);
    }
  });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ApiFailure) return sendFailure(reply, err);
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return sendFailure(
        reply,
        new ApiFailure(
          status === 404 ? "not_found" : status === 401 ? "unauthorized" : "validation",
          (err as Error).message,
          undefined,
          status,
        ),
      );
    }
    const failure = toApiFailure(err);
    if (failure.status >= 500) deps.log?.(`Request failed: ${failure.message}`);
    return sendFailure(reply, failure);
  });
  app.setNotFoundHandler((request, reply) =>
    sendFailure(
      reply,
      new ApiFailure("not_found", `No route for ${request.method} ${request.url}.`),
    ),
  );

  app.addHook("onRequest", async (request, reply) => {
    const config = request.routeOptions.config.agentbox;
    if (!config?.auth) return;
    if (!isAuthorized(authInput(request, config.ws), deps.token)) {
      // A refused upgrade leaves no HTTP connection worth keeping.
      if (config.ws) reply.header("connection", "close");
      return sendFailure(reply, new ApiFailure("unauthorized", "Missing or wrong bearer token."));
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
    config: { agentbox: { auth: def.auth, ws: false } },
    handler: async (request, reply) => {
      const ctx = {
        params: parse(params, request.params, "path"),
        query: def.query ? parse(def.query, request.query ?? {}, "query") : undefined,
        body: def.body ? parse(def.body, request.body, "body") : undefined,
        request,
        reply,
      };
      const result = await handler(ctx);
      const checked = def.response.safeParse(result);
      if (!checked.success) {
        throw new ApiFailure(
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

function parse(schema: z.ZodTypeAny, value: unknown, where: string): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiFailure(
      "validation",
      `The ${where} doesn't match its schema.`,
      result.error.issues,
    );
  }
  return result.data;
}

function registerWs(
  app: FastifyInstance,
  def: WsRouteDef,
  handler: (socket: WebSocket, request: FastifyRequest) => void | Promise<void>,
): void {
  app.route({
    method: "GET",
    url: fastifyPath(def.path),
    config: { agentbox: { auth: def.auth, ws: true } },
    handler: (_request, reply) =>
      sendFailure(
        reply,
        new ApiFailure("validation", "This route needs a WebSocket upgrade.", undefined, 426),
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
    throw new ApiFailure("validation", `Unknown event types: ${unknown.join(", ")}.`);
  return new Set(list as EventType[]);
}

function serveEvents(deps: ApiDeps, socket: WebSocket, request: FastifyRequest): void {
  let types: Set<EventType> | null;
  try {
    const query = serverRoutes["events.stream"].query.parse(request.query ?? {});
    types = parseTypes(query.types);
  } catch (err) {
    socket.close(1008, toApiFailure(err).message.slice(0, 120));
    return;
  }
  let sentUpTo: number | null = null;
  const send = (frame: unknown) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(ServerStreamFrameSchema.parse(frame)));
    }
  };
  const wanted = (event: AgentBoxEvent) => types === null || types.has(event.type);
  const unsubscribe = deps.hub.subscribe((event) => {
    if (sentUpTo === null || event.seq <= sentUpTo) return;
    sentUpTo = event.seq;
    if (wanted(event)) send(event);
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
    const plan = deps.hub.replay(hello);
    send(plan.hello);
    for (const event of plan.events) if (wanted(event)) send(event);
    sentUpTo = plan.hello.lastSeq;
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
    sendControl(socket, { type: "error", error: toApiFailure(err).toBody().error });
    socket.close(1008, "bad terminal request");
    return;
  }
  const end = await serveTerminal(socket, deps.exec, target);
  let unexpected = false;
  if (kind === "session" && !end.closedByClient && target.boxId) {
    try {
      unexpected = (await deps.core.boxes.get(target.boxId)).status === "stopped";
    } catch {
      unexpected = false;
    }
  }
  deps.hub.emit({
    type: "terminal.ended",
    terminalId: end.terminalId,
    boxId: target.boxId,
    kind,
    exitCode: end.exitCode,
    unexpected,
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
