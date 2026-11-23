// The build socket: a Unix socket inside the project container that accepts
// only build requests (planning seat calls, the freeze, start, status,
// pause, resume, and resolve) and needs no engine token. The `aio-build` command in a box's session talks to it; see
// `@aio/contracts` `build-socket.ts` for the protocol.
//
// The socket lives on the container's own file system, so only processes in
// this project's container reach it. Each request names its project, and
// the socket refuses a project other than the engine's own, and a build
// whose saved state belongs to another project.
import {
  BUILD_SOCKET_MAX_BODY_BYTES,
  BUILD_SOCKET_ROUTES,
  BuildSocketFreezeSchema,
  BuildSocketPlanSchema,
  BuildSocketResolveSchema,
  BuildSocketSlugSchema,
  BuildSocketStartSchema,
  type ApiError,
  type ApiErrorCode,
  type BuildSocketRequestKind,
  type BuildState,
} from "@aio/contracts";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname } from "node:path";
import { ZodError } from "zod";
import { EngineError, type Logger } from "../api/core-interface.js";
import { statusFor } from "../api/errors.js";
import type { BuildManager } from "../build/manager.js";

export interface BuildSocketOptions {
  /** The socket path. The engine makes its folder, mode 0700, when it's missing. */
  path: string;
  /** The requests the socket serves. */
  builds: Pick<BuildManager, "plan" | "freeze" | "start" | "get" | "pause" | "resume" | "resolve">;
  /** The engine's project, or `null` when the server didn't name one. */
  projectId: string | null;
  log: Logger;
}

export interface BuildSocketServer {
  readonly path: string;
  /** Stops listening and removes the socket file. */
  close(): Promise<void>;
}

const REFUSED =
  "The build socket serves only build requests: POST to " +
  Object.values(BUILD_SOCKET_ROUTES).join(", ") +
  ".";

const ROUTE_KINDS = new Map<string, BuildSocketRequestKind>(
  Object.entries(BUILD_SOCKET_ROUTES).map(([kind, route]) => [
    route,
    kind as BuildSocketRequestKind,
  ]),
);

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BUILD_SOCKET_MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function errorBody(code: ApiErrorCode, message: string, details?: unknown): ApiError {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** True when something answers at the socket path, as another engine would. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * Opens the build socket. A file left at the path by an engine that stopped
 * without cleaning up is replaced; a socket that another process still
 * listens on makes this throw.
 */
export async function serveBuildSocket(options: BuildSocketOptions): Promise<BuildSocketServer> {
  const { path, builds, projectId, log } = options;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let existing: ReturnType<typeof lstatSync> | null;
  try {
    existing = lstatSync(path);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isDirectory()) throw new Error(`${path} is a folder, not a socket.`);
    if (await answers(path)) throw new Error(`Another process listens on ${path}.`);
    unlinkSync(path);
  }

  /** The build `slug`, when it belongs to `project`; otherwise `not_found`. */
  const ownBuild = async (project: string, slug: string): Promise<BuildState> => {
    const build = await builds.get(slug);
    if (!build || build.projectId !== project) {
      throw new EngineError("not_found", `Project ${project} has no build ${slug}.`);
    }
    return build;
  };

  /** Refuses a request for a project other than the engine's own. */
  const ownProject = (request: { projectId: string; slug: string }): void => {
    if (projectId !== null && request.projectId !== projectId) {
      throw new EngineError(
        "not_found",
        `Project ${request.projectId} has no build ${request.slug}.`,
      );
    }
  };

  /** Handles one request and returns its answer's body. */
  const handle = async (kind: BuildSocketRequestKind, raw: unknown): Promise<unknown> => {
    if (kind === "plan") {
      const request = BuildSocketPlanSchema.parse(raw);
      ownProject(request);
      return builds.plan(request);
    }
    if (kind === "freeze") {
      const request = BuildSocketFreezeSchema.parse(raw);
      ownProject(request);
      return builds.freeze(request);
    }
    if (kind === "start") {
      const request = BuildSocketStartSchema.parse(raw);
      if (projectId !== null && request.projectId !== projectId) {
        throw new EngineError(
          "not_found",
          `This container runs project ${projectId}, not ${request.projectId}.`,
        );
      }
      const build = await builds.start({
        projectId: request.projectId,
        ...(request.boxId !== null ? { boxId: request.boxId } : {}),
        slug: request.slug,
        ...(request.plan !== undefined ? { plan: request.plan } : {}),
        ...(request.base !== undefined ? { base: request.base } : {}),
      });
      return { build };
    }
    if (kind === "resolve") {
      const {
        projectId: project,
        boxId: _box,
        slug,
        ...resolution
      } = BuildSocketResolveSchema.parse(raw);
      ownProject({ projectId: project, slug });
      await ownBuild(project, slug);
      return { build: await builds.resolve(slug, resolution) };
    }
    const request = BuildSocketSlugSchema.parse(raw);
    ownProject(request);
    const build = await ownBuild(request.projectId, request.slug);
    if (kind === "status") return { build };
    if (kind === "pause") return { build: await builds.pause(request.slug) };
    return { build: await builds.resume(request.slug) };
  };

  const server = http.createServer((req, res) => {
    const kind = req.method === "POST" ? ROUTE_KINDS.get(req.url ?? "") : undefined;
    if (kind === undefined) {
      req.resume();
      const status = ROUTE_KINDS.has(req.url ?? "") ? 405 : 404;
      reply(res, status, errorBody("not_found", REFUSED));
      return;
    }
    void (async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(await readBody(req));
      } catch (error) {
        const tooLarge = error instanceof BodyTooLarge;
        reply(
          res,
          tooLarge ? 413 : 400,
          errorBody(
            "validation",
            tooLarge
              ? `The request is over ${BUILD_SOCKET_MAX_BODY_BYTES} bytes.`
              : "The request body isn't JSON.",
          ),
        );
        return;
      }
      try {
        const body = await handle(kind, raw);
        reply(res, kind === "start" || kind === "freeze" ? 201 : 200, body);
      } catch (error) {
        if (error instanceof ZodError) {
          reply(
            res,
            400,
            errorBody("validation", "The request doesn't match its schema.", error.issues),
          );
        } else if (error instanceof EngineError) {
          reply(res, statusFor(error.code), errorBody(error.code, error.message, error.details));
        } else {
          log.error("A build socket request failed", { request: kind, error: String(error) });
          reply(res, 500, errorBody("internal", "The engine failed to handle the build request."));
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  log.info("The build socket is listening", { path });

  let closing: Promise<void> | null = null;
  return {
    path,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
