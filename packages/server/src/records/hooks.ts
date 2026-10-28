// What the core asks W2's services for. W2 replaces the defaults with
// `core.setHooks()`; the defaults keep the core usable on its own.
import type { Listener, ReviewState } from "@agentbox/contracts";

export interface EngineHealth {
  /** From the engine's health route; `null` until it answers. */
  version: string | null;
  healthy: boolean;
}

export interface CoreHooks {
  /** Whether a run holds the box. Default: idle. */
  reviewState(boxId: string): ReviewState;
  /** The listeners the engine of `container` reported. Default: none. */
  listeners(container: string): Listener[];
  /** The engine's health as W2 last saw it. Default: unknown. */
  engineHealth(container: string): EngineHealth;
  /**
   * The environment to inject into a project container at creation: the
   * resolved secrets. Throw an `ApiError` (`secrets_locked`,
   * `secrets_unavailable`) to block the launch. Default: none.
   */
  resolveEnv(projectId: string): Promise<Record<string, string>>;
}

export function defaultHooks(): CoreHooks {
  return {
    reviewState: () => ({ state: "idle" }),
    listeners: () => [],
    engineHealth: () => ({ version: null, healthy: false }),
    resolveEnv: async () => ({}),
  };
}
