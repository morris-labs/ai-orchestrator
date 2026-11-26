// The team chat bus: the MCP endpoint that agents send messages through, the
// message files, and the routing rules. See ADR 0004 and
// `docs/build-pipeline/team-chat.md`.
export { TEAM_MCP_PATH, TEAM_SERVER_NAME, TeamBus, type TeamBusOptions } from "./bus.js";
export {
  MessageRefused,
  TeamChannel,
  type TeamChannelOptions,
  type TeamMember,
  type TeamPass,
} from "./channel.js";
export { routeMessage, taskOwning, type Route, type RouteTask } from "./routing.js";
