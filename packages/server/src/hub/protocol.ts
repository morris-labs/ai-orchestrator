// The hub-node link protocol: the frames that travel over the one WebSocket
// a node keeps open to its hub, and the hello that both ends exchange first.
//
// Every frame is a JSON text frame. Request and stream bodies travel as
// base64, so a frame never mixes text and bytes. Either end can send
// requests and open streams; the side that starts one numbers it with its
// own prefix (`h` on the hub, `n` on the node), so the two ends never pick
// the same id.
import { MachineRoleSchema } from "@aio/contracts";
import { z } from "zod";

/**
 * The link protocol's major version. Both ends must have the same one; a
 * change that an older end can't understand raises it. Anything smaller
 * goes in the capability list instead.
 */
export const LINK_PROTOCOL = 1;

/**
 * What this server can do over a link. A feature that needs the other end's
 * help checks the other end's list first, so an older machine keeps working
 * without it.
 */
export const LINK_CAPABILITIES: readonly string[] = [
  "http.v1",
  "stream.v1",
  "machines.v1",
  "secrets.op.v1",
  "credentials.v1",
  "flow.v1",
  "health.v1",
];

/**
 * The bytes a stream may send before the receiver grants more credit, with
 * `flow.v1`. A receiver grants credit back once its own sink has taken the
 * bytes, so a slow sink slows the sender instead of filling memory.
 */
export const STREAM_WINDOW = 1024 * 1024;

/** WebSocket close codes the link uses. */
export const LINK_CLOSE = {
  /** The other end speaks another protocol major version. */
  protocolRefused: 4400,
  /** The machine's certificate is revoked. */
  revoked: 4403,
  /** A newer link from the same machine replaced this one. */
  replaced: 4409,
  /** The other end didn't say hello in time. */
  helloTimeout: 4408,
} as const;

/** The paths on the hub's link listener. */
export const LINK_PATHS = {
  enroll: "/link/v1/enroll",
  connect: "/link/v1/connect",
} as const;

/** Paths under this prefix reach a link end's own handlers, never its API. */
export const LINK_INTERNAL_PREFIX = "/link/v1/";

export const LinkHelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int(),
  capabilities: z.array(z.string()),
  serverVersion: z.string(),
  platform: z.string(),
  name: z.string(),
  role: MachineRoleSchema,
});
export type LinkHello = z.infer<typeof LinkHelloSchema>;

const Headers = z.record(z.string(), z.string());

export const LinkFrameSchema = z.discriminatedUnion("type", [
  LinkHelloSchema,
  z.object({ type: z.literal("refuse"), reason: z.string() }),
  z.object({
    type: z.literal("req"),
    id: z.string(),
    method: z.string(),
    path: z.string(),
    query: z.string().optional(),
    headers: Headers,
    body: z.string().optional(),
  }),
  z.object({
    type: z.literal("res"),
    id: z.string(),
    status: z.number().int(),
    headers: Headers,
    body: z.string(),
  }),
  z.object({
    type: z.literal("open"),
    id: z.string(),
    path: z.string(),
    query: z.string().optional(),
    headers: Headers,
  }),
  z.object({ type: z.literal("opened"), id: z.string() }),
  z.object({
    type: z.literal("openFailed"),
    id: z.string(),
    status: z.number().int(),
    message: z.string(),
  }),
  z.object({ type: z.literal("data"), id: z.string(), binary: z.boolean(), data: z.string() }),
  z.object({ type: z.literal("end"), id: z.string(), code: z.number().int(), reason: z.string() }),
  z.object({ type: z.literal("credit"), id: z.string(), bytes: z.number().int().positive() }),
]);
export type LinkFrame = z.infer<typeof LinkFrameSchema>;

/** Parses one frame, or returns `null` for anything that isn't one. */
export function parseFrame(text: string): LinkFrame | null {
  try {
    const parsed = LinkFrameSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The protocol major version of a hello. */
export function protocolMajor(protocol: number): number {
  return Math.trunc(protocol);
}

/** Why two ends can't link, or `null` when their protocol versions agree. */
export function protocolMismatch(ours: number, theirs: number): string | null {
  if (protocolMajor(ours) === protocolMajor(theirs)) return null;
  const newer = theirs > ours ? "this machine" : "the other machine";
  return `The link protocol versions differ: this machine speaks ${ours}, the other machine speaks ${theirs}. Update AI Orchestrator on ${newer} so both speak the same version.`;
}

/** The platforms a machine record names; anything else shows as `null`. */
export function machinePlatform(platform: string): "linux" | "darwin" | "win32" | null {
  return platform === "linux" || platform === "darwin" || platform === "win32" ? platform : null;
}

/**
 * A close code that `ws` lets a program send. Codes the protocol reserves
 * for the library, such as 1005 (no status) and 1006 (abnormal close),
 * become 1000 and 1011.
 */
export function sendableCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1005) return 1000;
  if (code === 1006 || code === 1015) return 1011;
  if ((code >= 1000 && code <= 1014 && code !== 1004) || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1011;
}

/** A close reason short enough for a close frame, which holds 123 bytes. */
export function closeReason(reason: string): string {
  let out = reason;
  while (Buffer.byteLength(out) > 120) out = out.slice(0, -1);
  return out;
}
