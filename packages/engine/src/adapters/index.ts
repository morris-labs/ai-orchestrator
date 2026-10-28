// Public entry point of the vendor adapters.
import type { Vendor } from "@agentbox/contracts";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "./claude.js";
import { CodexAdapter, type CodexAdapterOptions } from "./codex.js";
import { CopilotAdapter, type CopilotAdapterOptions } from "./copilot.js";
import type { CliVendorAdapter } from "./types.js";

export * from "./types.js";
export * from "./process.js";
export * from "./json.js";
export * from "./output.js";
export * from "./retry.js";
export { CliAdapter, detectLimitInText, parseResetTime, type CliAdapterOptions } from "./base.js";
export * from "./claude.js";
export * from "./codex.js";
export * from "./copilot.js";
export * from "./mock.js";
export * from "./bridge.js";

export interface AdapterOptionsByVendor {
  claude?: ClaudeAdapterOptions;
  codex?: CodexAdapterOptions;
  copilot?: CopilotAdapterOptions;
}

/** Creates the real CLI adapter for each vendor. `bridgeAdapters()` turns them into core adapters. */
export function createAdapters(
  options: AdapterOptionsByVendor = {},
): Record<Vendor, CliVendorAdapter> {
  return {
    claude: new ClaudeAdapter(options.claude),
    codex: new CodexAdapter(options.codex),
    copilot: new CopilotAdapter(options.copilot),
  };
}
