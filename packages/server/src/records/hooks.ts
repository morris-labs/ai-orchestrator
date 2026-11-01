// What the core asks the server's services for. `createCore()` in
// `src/core.ts` replaces the defaults with `setHooks()`; the defaults keep the
// core usable on its own, as in the core tests.
import type { Listener, ReviewState } from "@aio/contracts";

export interface EngineHealth {
  /** From the engine's health route; `null` until it answers. */
  version: string | null;
  healthy: boolean;
  /**
   * Whether the engine matches the version this server expects, as the
   * engine client decided it; `null` until known. When absent, the core
   * compares `version` with its own expected version.
   */
  versionMatches?: boolean | null;
}

/** The TCP broker a container is about to be created with. */
export interface PrepareBrokerTcp {
  transport: "tcp";
  port: number;
}

export interface CoreHooks {
  /** Whether a run holds the box. Default: idle. */
  reviewState(boxId: string): ReviewState;
  /** The listeners the engine of `container` reported. Default: none. */
  listeners(container: string): Listener[];
  /** The engine's health as the engine client last saw it. Default: unknown. */
  engineHealth(container: string): EngineHealth;
  /**
   * The pre-start check of a project container: resolves every secret
   * reference, opens the container's secrets broker socket, and returns the
   * names the container may request. Throw an `ApiError` (`secrets_locked`,
   * `secrets_unavailable`) to block the launch. Default: no secrets and no
   * socket.
   *
   * `broker` is present only for the TCP transport: the broker then listens
   * on `127.0.0.1:port` with a token it writes fresh for the new container.
   */
  prepareSecrets(
    projectId: string,
    container: string,
    broker?: PrepareBrokerTcp,
  ): Promise<string[]>;
  /**
   * The SHA-512 crypt hash of the container user's sudo password, installed
   * in a project container at creation, or `null` to turn sudo off. Throws
   * like `prepareSecrets` to block the launch. Default: `null`.
   */
  sudoPasswordHash(): Promise<string | null>;
  /**
   * The port the broker listens on for `container` over TCP, or `null`. A
   * port the broker itself holds counts as free when the container is
   * created again. Default: `null`.
   */
  brokerTcpPort?(container: string): number | null;
}

export function defaultHooks(): CoreHooks {
  return {
    reviewState: () => ({ state: "idle" }),
    listeners: () => [],
    engineHealth: () => ({ version: null, healthy: false }),
    prepareSecrets: async () => [],
    sudoPasswordHash: async () => null,
    brokerTcpPort: () => null,
  };
}
