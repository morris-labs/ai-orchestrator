// The build socket's protocol: HTTP/1.1 with JSON bodies, over a Unix
// socket that the engine opens inside its project container. The socket
// accepts only build requests (planning seat calls, meetings, the freeze, start,
// status, pause, and resume) and needs
// no engine token, so a box's session can drive a build with the
// `aio-build` command without the token that the engine's full API
// requires. See `docs/build-pipeline/design.md`.
import { z } from "zod";
import { BuildSlugSchema } from "./build-events.js";
import {
  BuildFreezeAnswerSchema,
  BuildFreezeRequestSchema,
  BuildSeatAnswerSchema,
  BuildSeatRequestSchema,
} from "./build-planning.js";
import {
  BuildMeetingAnswerSchema,
  BuildMeetingPostRequestSchema,
  BuildMeetingRequestSchema,
} from "./build-meetings.js";
import { BuildPlanSchema, BuildStateSchema } from "./builds.js";
import { ENGINE_ENV } from "./config.js";

/**
 * The folder that holds the socket inside a container. It sits on the
 * container's own file system, not on a bind mount, so only processes in
 * the project's container can reach it.
 */
export const BUILD_SOCKET_DIR = "/tmp/aio-build";

/** The socket path inside a container. */
export const BUILD_SOCKET_PATH = `${BUILD_SOCKET_DIR}/build.sock`;

/** Environment variables that the engine and the `aio-build` command read. */
export const BUILD_SOCKET_ENV = {
  /** Replaces `BUILD_SOCKET_PATH`, for an engine started by hand and for tests. */
  socket: "AIO_BUILD_SOCKET",
  /**
   * The project's ID. The server sets it on every project container; the
   * command sends it with each request, and the engine refuses a request
   * for any other project.
   */
  projectId: ENGINE_ENV.projectId,
  /** The box's ID. The server sets it on every box session; the command sends it. */
  boxId: "AIO_BOX_ID",
} as const;

/** The socket's routes, one for each build request. Every route takes `POST`. */
export const BUILD_SOCKET_ROUTES = {
  plan: "/v1/builds/plan",
  freeze: "/v1/builds/freeze",
  meet: "/v1/builds/meet",
  "meeting-post": "/v1/builds/meeting-post",
  start: "/v1/builds/start",
  status: "/v1/builds/status",
  pause: "/v1/builds/pause",
  resume: "/v1/builds/resume",
} as const;
export type BuildSocketRequestKind = keyof typeof BUILD_SOCKET_ROUTES;

/** The largest request body the socket reads, in bytes. */
export const BUILD_SOCKET_MAX_BODY_BYTES = 1024 * 1024;

/** Who asks: every request names its project and, from a box session, its box. */
const scope = {
  projectId: z.string().min(1),
  boxId: z.string().min(1).nullable(),
};

/** The body of a start request: the build's slug and, unless the build has a frozen plan, its plan. */
export const BuildSocketStartSchema = z
  .object({
    ...scope,
    slug: BuildSlugSchema,
    /** The build plan. Absent means the build's latest frozen plan. */
    plan: BuildPlanSchema.optional(),
    /** The branch, tag, or commit the build branch starts from. Absent means `HEAD`. */
    base: z.string().min(1).optional(),
  })
  .strict();
export type BuildSocketStart = z.infer<typeof BuildSocketStartSchema>;
export type BuildSocketStartInput = z.input<typeof BuildSocketStartSchema>;

/** The body of a status, pause, or resume request. */
export const BuildSocketSlugSchema = z.object({ ...scope, slug: BuildSlugSchema }).strict();
export type BuildSocketSlug = z.infer<typeof BuildSocketSlugSchema>;

/** The body of a planning seat call. */
export const BuildSocketPlanSchema = BuildSeatRequestSchema;

/** The body of a freeze request. */
export const BuildSocketFreezeSchema = BuildFreezeRequestSchema;

/** The body of a meeting request. */
export const BuildSocketMeetSchema = BuildMeetingRequestSchema;

/** The body of an owner post to a running meeting. */
export const BuildSocketMeetingPostSchema = BuildMeetingPostRequestSchema;

/** The answer to a start, status, pause, or resume request: the build's state after the request. */
export const BuildSocketResponseSchema = z.object({ build: BuildStateSchema });
export type BuildSocketResponse = z.infer<typeof BuildSocketResponseSchema>;

/** The answer to each request, by kind. */
export const BUILD_SOCKET_RESPONSES = {
  plan: BuildSeatAnswerSchema,
  freeze: BuildFreezeAnswerSchema,
  meet: BuildMeetingAnswerSchema,
  "meeting-post": BuildMeetingAnswerSchema,
  start: BuildSocketResponseSchema,
  status: BuildSocketResponseSchema,
  pause: BuildSocketResponseSchema,
  resume: BuildSocketResponseSchema,
} as const satisfies Record<BuildSocketRequestKind, z.ZodTypeAny>;
export type BuildSocketAnswer<K extends BuildSocketRequestKind> = z.infer<
  (typeof BUILD_SOCKET_RESPONSES)[K]
>;
