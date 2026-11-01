// Routing a server API call to a machine.
//
// Every server route also answers under `/api/v1/machines/ID/proxy`, where
// `ID` names the machine that serves the call:
//
// - `local` always means the server that receives the request, so a client
//   can use the prefixed form without knowing the machine's enrolled name.
// - On a hub, any other ID is a connected node; the hub forwards the call
//   over that node's link as `/api/v1/<rest>`.
// - On a plain node, any other ID goes to the hub unchanged, and the hub
//   routes it on.
//
// WebSocket routes work the same way: the server relays the frames.

/** The machine ID that always names the server receiving the request. */
export const LOCAL_MACHINE_ID = "local";

/** The prefix of every server route. */
export const API_PREFIX = "/api/v1";

/** The path pattern of the machine proxy route, as Fastify writes it. */
export const MACHINE_PROXY_PATH = `${API_PREFIX}/machines/:machineId/proxy/*`;

/** The header a server adds to a call it forwards to another machine. */
export const FORWARDED_BY_HEADER = "x-aio-forwarded-by";

/**
 * The route prefix that sends a call to `machineId`: `/api/v1` for
 * `local` or no machine, and `/api/v1/machines/ID/proxy` otherwise.
 */
export function machineApiPrefix(machineId?: string | null): string {
  if (!machineId || machineId === LOCAL_MACHINE_ID) return API_PREFIX;
  return `${API_PREFIX}/machines/${encodeURIComponent(machineId)}/proxy`;
}

/**
 * Rewrites a server route path, such as `/api/v1/boxes`, to send it to
 * `machineId`. A path outside `/api/v1` comes back unchanged.
 */
export function machinePath(path: string, machineId?: string | null): string {
  if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) return path;
  return `${machineApiPrefix(machineId)}${path.slice(API_PREFIX.length)}`;
}
