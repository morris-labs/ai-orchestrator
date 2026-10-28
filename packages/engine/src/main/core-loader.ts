// Loads the engine core (`src/core.ts`, built by another workstream) at run
// time, so the service builds and runs before the core exists.
import { fileURLToPath } from "node:url";
import { EngineError, type CoreDeps, type RunManager } from "../api/core-interface.js";

/** What `core.ts` must export. */
export interface CoreModule {
  createRunManager(deps: CoreDeps): RunManager | Promise<RunManager>;
}

/** A run manager for a build without the core: reads are empty, actions fail. */
export function unavailableRunManager(): RunManager {
  const fail = async (): Promise<never> => {
    throw new EngineError("conflict", "This engine build has no review core.");
  };
  return {
    list: async () => [],
    preview: fail,
    start: fail,
    get: async () => null,
    pause: fail,
    resume: fail,
    cancel: fail,
    profile: fail,
    assign: fail,
    rebaseBase: fail,
    decide: fail,
    push: fail,
    groups: fail,
    rounds: fail,
    findings: fail,
    finding: async () => null,
    waive: fail,
    usageSamples: async () => [],
    activeRunCount: () => 0,
  };
}

/**
 * Imports `core.js` next to the engine's entry point and builds the run
 * manager. Falls back to `unavailableRunManager()` only when the module
 * itself is missing; any other import error propagates.
 */
export async function loadCore(
  deps: CoreDeps,
  specifier: URL = new URL("../core.js", import.meta.url),
): Promise<{ runs: RunManager; available: boolean }> {
  let mod: Partial<CoreModule>;
  try {
    mod = (await import(specifier.href)) as Partial<CoreModule>;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const missing =
      e.code === "ERR_MODULE_NOT_FOUND" &&
      [fileURLToPath(specifier), specifier.href].some((name) =>
        String(e.message).startsWith(`Cannot find module '${name}'`),
      );
    if (!missing) throw err;
    deps.log.warn("The engine core isn't installed; run routes answer with errors");
    return { runs: unavailableRunManager(), available: false };
  }
  if (typeof mod.createRunManager !== "function") {
    throw new Error("core.js doesn't export createRunManager().");
  }
  return { runs: await mod.createRunManager(deps), available: true };
}
