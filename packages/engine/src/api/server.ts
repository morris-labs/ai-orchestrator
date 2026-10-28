// Builds the engine's Fastify app from the contracts' `engineRoutes` table:
// HTTP routes with zod validation of params, query, body, and response, the
// event WebSocket, and the `/proxy/:port/*` pass-through.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  EventsQuerySchema,
  engineRoutes,
  pathParamsSchema,
  type ApiError,
  type HttpRouteDef,
  type RouteDef,
} from "@agentbox/contracts";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { WebSocketServer } from "ws";
import type { EventHub } from "../events/hub.js";
import type { EngineLeaseBroker } from "../events/leases.js";
import { parseTypesFilter, serveEventSocket } from "../events/stream.js";
import { PROXY_PREFIX, parseProxyUrl, proxyHttp, proxyUpgrade } from "../proxy/proxy.js";
import { isAuthorized, redactUrl } from "./auth.js";
import type { Logger } from "./core-interface.js";
import { mapError } from "./errors.js";
import type { EngineHandlers, EngineHttpKey, HandlerDeps } from "./handlers.js";
import { createHandlers } from "./handlers.js";

export interface EngineAppOptions extends Omit<HandlerDeps, "health"> {
  token: string;
  container: string;
  projectRoot: string;
  /** The engine's package version. */
  engineVersion: string;
  /** `AGENTBOX_ENGINE_VERSION`: the version the server expects. */
  expectedVersion: string;
  hub: EventHub;
  leases: EngineLeaseBroker;
  log: Logger;
  /** When the process started, in epoch milliseconds. */
  startedAt?: number;
  /** Replaces handlers, for tests. */
  handlers?: Partial<EngineHandlers>;
}

const UNAUTHORIZED: ApiError = {
  error: { code: "validation", message: "The engine needs a valid bearer token." },
};

function sendRawError(res: ServerResponse, status: number, body: ApiError): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Builds the app. Call `listen()` on the result to serve it. */
export async function buildEngineApp(options: EngineAppOptions): Promise<FastifyInstance> {
  const { log, token } = options;
  const startedAt = options.startedAt ?? Date.now();
  const versionMatches = options.engineVersion === options.expectedVersion;
  const handlers: EngineHandlers = {
    ...createHandlers({
      ...options,
      health: () => ({
        version: options.engineVersion,
        uptimeS: (Date.now() - startedAt) / 1000,
        engineVersion: options.engineVersion,
        container: options.container,
        projectRoot: options.projectRoot,
        streamId: options.hub.streamId,
      }),
    }),
    ...options.handlers,
  } as EngineHandlers;

  const proxyOptions = { engineToken: token, log };
  const app = Fastify({
    logger: false,
    // The proxy bypasses Fastify so request bodies stream through untouched.
    serverFactory: (handler) =>
      http.createServer((req, res) => {
        const target = req.url?.startsWith(PROXY_PREFIX) ? parseProxyUrl(req.url, token) : null;
        if (target === null) return handler(req, res);
        if (!isAuthorized(req, token, false)) return sendRawError(res, 401, UNAUTHORIZED);
        log.debug("Proxy request", { method: req.method, port: target.port });
        proxyHttp(req, res, target, proxyOptions);
      }),
  });

  // JSON bodies: an empty body counts as no body, for routes that take none.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = Object.assign(new Error("The body isn't valid JSON."), { code: "validation" });
      done(err, undefined);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = mapError(err);
    if (mapped.status >= 500) {
      log.error("Request failed", {
        method: req.method,
        url: redactUrl(req.url),
        error: String(err),
      });
    }
    void reply.code(mapped.status).send(mapped.body);
  });
  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .send({ error: { code: "not_found", message: `No route ${req.method} ${req.url}.` } });
  });
  app.addHook("onResponse", (req, reply, done) => {
    log.debug("Request", { method: req.method, url: redactUrl(req.url), status: reply.statusCode });
    done();
  });

  const unauthorized = (reply: FastifyReply) => reply.code(401).send(UNAUTHORIZED);

  for (const [key, def] of Object.entries(engineRoutes) as [string, RouteDef][]) {
    if (def.kind !== "http") continue;
    const route: HttpRouteDef = def;
    const handler = handlers[key as EngineHttpKey] as (input: unknown) => unknown;
    const paramsSchema = pathParamsSchema(route.path);
    app.route({
      method: route.method,
      url: route.path,
      handler: async (req, reply) => {
        if (route.auth && !isAuthorized(req.raw, token, false)) return unauthorized(reply);
        const input = {
          params: paramsSchema.parse(req.params),
          query: route.query ? route.query.parse(req.query ?? {}) : undefined,
          body: route.body ? route.body.parse(req.body ?? {}) : undefined,
        };
        const output = route.response.parse(await handler(input));
        const body = key === "engine.health" ? { ...output, versionMatches } : output;
        return reply.code(route.status ?? 200).send(body);
      },
    });
  }

  // WebSockets: the event stream and proxied upgrades.
  const eventsPath = engineRoutes["engine.events"].path;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    if (url.startsWith(PROXY_PREFIX)) {
      const target = parseProxyUrl(url, token);
      if (target === null) return rejectUpgrade(socket, 404, "Not Found");
      if (!isAuthorized(req, token, true)) return rejectUpgrade(socket, 401, "Unauthorized");
      return proxyUpgrade(req, socket, head, target, proxyOptions);
    }
    if (pathname !== eventsPath) return rejectUpgrade(socket, 404, "Not Found");
    if (!isAuthorized(req, token, true)) return rejectUpgrade(socket, 401, "Unauthorized");
    const query = EventsQuerySchema.safeParse(
      Object.fromEntries(new URL(url, "http://engine").searchParams),
    );
    if (!query.success) return rejectUpgrade(socket, 400, "Bad Request");
    wss.handleUpgrade(req, socket, head, (ws) => {
      log.info("Event subscriber connected");
      ws.on("close", () => log.info("Event subscriber disconnected"));
      serveEventSocket(ws, {
        hub: options.hub,
        leases: options.leases,
        log,
        types: parseTypesFilter(query.data.types),
      });
    });
  });
  app.addHook("onClose", (_instance, done) => {
    for (const client of wss.clients) client.close(1001, "The engine is shutting down.");
    wss.close(() => done());
  });

  return app;
}
