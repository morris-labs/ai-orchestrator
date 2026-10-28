// Public entry point of `@agentbox/engine`: the core's interfaces, the run
// controller and manager, and the API's `RunManager` interface. Vendor
// adapters are under `@agentbox/engine/adapters`.
export * from "./core.js";
export {
  InvalidStateError,
  RunController,
  runDirFor,
  type RunLocation,
} from "./state/controller.js";
export { EngineRunManager, createRunManager, toApiError } from "./state/manager.js";
export {
  ACTIVE_RUN_STATUSES,
  EngineError,
  type CoreDeps,
  type FindingDetail,
  type FindingFilter,
  type Logger,
  type RunListFilter,
  type RunManager,
  type RunPreview,
  type UsageFilter,
} from "./api/core-interface.js";
