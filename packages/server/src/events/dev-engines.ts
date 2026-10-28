// The `AGENTBOX_DEV_ENGINES` development switch: engine endpoints for
// projects that have no container, such as an engine started as a local
// process in an end-to-end test. The supervisor subscribes to them like to
// any container's engine, and run routes resolve to them by project id.
import { isIP } from "node:net";
import { projectContainerName } from "@agentbox/contracts";
import type { CoreEngines, EngineEndpoint } from "../api/core-interface.js";

/** The environment variable that lists development engines. */
export const DEV_ENGINES_ENV = "AGENTBOX_DEV_ENGINES";

const PROJECT_ID = /^[A-Za-z0-9-]+-[0-9a-f]{8}$/;

/** Returns true for `localhost` and every IPv4 or IPv6 loopback address. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (h === "localhost") return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) return h === "::1" || h === "0:0:0:0:0:0:0:1";
  return false;
}

/**
 * Parses `projectId=host:port:token[,...]` into engine endpoints. Each
 * endpoint's container is the project's container name, which the engine
 * must also get as `AGENTBOX_CONTAINER`, because the server finds the engine
 * that holds a run by the run's `container`. The host must be a loopback
 * address: the server always reaches an engine on 127.0.0.1.
 *
 * Throws an `Error` that names the bad entry, never the token.
 */
export function parseDevEngines(value: string | undefined): EngineEndpoint[] {
  if (value === undefined || value.trim() === "") return [];
  const endpoints: EngineEndpoint[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.split(",").entries()) {
    const entry = raw.trim();
    const where = `${DEV_ENGINES_ENV} entry ${index + 1}`;
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`${where} must have the form projectId=host:port:token.`);
    const projectId = entry.slice(0, eq);
    if (!PROJECT_ID.test(projectId)) {
      throw new Error(`${where} has an invalid project id, ${projectId}.`);
    }
    const rest = entry.slice(eq + 1);
    const tokenAt = rest.lastIndexOf(":");
    const portAt = tokenAt > 0 ? rest.lastIndexOf(":", tokenAt - 1) : -1;
    if (portAt <= 0) throw new Error(`${where} must have the form projectId=host:port:token.`);
    const host = rest.slice(0, portAt);
    const portText = rest.slice(portAt + 1, tokenAt);
    const token = rest.slice(tokenAt + 1);
    if (!isLoopbackHost(host)) {
      throw new Error(`${where} names ${host}; a development engine must be on a loopback host.`);
    }
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
      throw new Error(`${where} has an invalid port, ${portText}.`);
    }
    if (token.length < 16) {
      throw new Error(`${where} has a token shorter than 16 characters.`);
    }
    if (seen.has(projectId)) throw new Error(`${where} repeats project ${projectId}.`);
    seen.add(projectId);
    endpoints.push({
      container: projectContainerName(projectId),
      projectId,
      hostPort: port,
      token,
    });
  }
  return endpoints;
}

/**
 * Refuses development engines unless the server binds to a loopback host,
 * because they skip the container that otherwise isolates an engine.
 */
export function assertDevEnginesAllowed(endpoints: EngineEndpoint[], bindHost: string): void {
  if (endpoints.length > 0 && !isLoopbackHost(bindHost)) {
    throw new Error(
      `${DEV_ENGINES_ENV} is set, but the server binds to ${bindHost}. Development engines need a loopback bind address.`,
    );
  }
}

/**
 * Adds development engines to the core's list. A container that already
 * runs for the same project keeps its own engine.
 */
export function withDevEngines(engines: CoreEngines, dev: EngineEndpoint[]): CoreEngines {
  if (dev.length === 0) return engines;
  return {
    list: async () => {
      const live = await engines.list();
      const taken = new Set(live.map((e) => e.container));
      return [...live, ...dev.filter((e) => !taken.has(e.container))];
    },
  };
}
