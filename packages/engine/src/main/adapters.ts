// Picks the vendor adapters the engine runs with: the real CLIs that answer
// `--version`, or scripted mocks when `AGENTBOX_MOCK_VENDORS=1`.
import { readFileSync } from "node:fs";
import { VendorSchema, type Vendor } from "@agentbox/contracts";
import { z } from "zod";
import type { Logger } from "../api/core-interface.js";
import { bridgeAdapters } from "../adapters/bridge.js";
import { createAdapters } from "../adapters/index.js";
import { MockAdapter, MockResponseSchema, type MockResponse } from "../adapters/mock.js";
import type { CliVendorAdapter } from "../adapters/types.js";
import type { AdapterSet } from "../core.js";

/** Set to `1` to answer every vendor call from a script instead of a CLI. */
export const MOCK_VENDORS_ENV = "AGENTBOX_MOCK_VENDORS";
/** A JSON file with a `responses` list per vendor, for `AGENTBOX_MOCK_VENDORS=1`. */
export const MOCK_SCRIPT_ENV = "AGENTBOX_MOCK_SCRIPT";

const VENDORS: readonly Vendor[] = ["claude", "codex", "copilot"];

/** The mock script file: the `MockScript` responses, keyed by vendor. */
export const MockScenarioSchema = z.record(
  VendorSchema,
  z.object({ responses: z.array(MockResponseSchema) }),
);

/**
 * Responses that answer each method with a valid, empty result: no
 * findings, every finding disproved, nothing fixed. A run against them
 * finishes clean.
 */
export function defaultMockResponses(vendor: Vendor): MockResponse[] {
  const answer = (method: MockResponse["method"], output: unknown) =>
    MockResponseSchema.parse({ method, output, model: `mock-${vendor}` });
  return [
    answer("review", { findings: [], ledger: [] }),
    answer("continueReview", { findings: [], ledger: [] }),
    answer("verify", {
      verdict: "disproved",
      verification: "code-reading",
      evidence: "The mock disprover disproves every finding.",
      presentAtBase: false,
      script: null,
    }),
    answer("fix", { fixed: [], notFixed: [], summary: "" }),
    answer("confirm", { incomplete: [], findings: [] }),
    answer("sweep", { findings: [] }),
  ];
}

/**
 * Builds one `MockAdapter` per vendor. A vendor's responses from the script
 * file come first, followed by the defaults, so a script only needs the
 * calls it cares about.
 */
export function createMockAdapters(scriptPath?: string): Record<Vendor, MockAdapter> {
  const scenario = scriptPath
    ? MockScenarioSchema.parse(JSON.parse(readFileSync(scriptPath, "utf8")))
    : {};
  const out = {} as Record<Vendor, MockAdapter>;
  for (const vendor of VENDORS) {
    out[vendor] = new MockAdapter({
      vendor,
      responses: [...(scenario[vendor]?.responses ?? []), ...defaultMockResponses(vendor)],
    });
  }
  return out;
}

export interface SelectedAdapters {
  adapters: AdapterSet;
  mock: boolean;
  /** Vendors left out because their CLI didn't answer. */
  missing: Array<{ vendor: Vendor; error: string | null }>;
}

/** Returns the adapters for the engine's environment. */
export async function selectAdapters(
  env: Record<string, string | undefined>,
  log: Logger,
  candidates: () => Record<Vendor, CliVendorAdapter> = () => createAdapters(),
): Promise<SelectedAdapters> {
  if (env[MOCK_VENDORS_ENV] === "1") {
    const script = env[MOCK_SCRIPT_ENV] || undefined;
    log.warn("Vendor calls answer from mock scripts", { script: script ?? "built-in" });
    return { adapters: bridgeAdapters(createMockAdapters(script)), mock: true, missing: [] };
  }
  const all = candidates();
  const checks = await Promise.all(
    VENDORS.map(async (v) => ({ v, health: await all[v].health() })),
  );
  const available: Partial<Record<Vendor, CliVendorAdapter>> = {};
  const missing: SelectedAdapters["missing"] = [];
  for (const { v, health } of checks) {
    if (health.available) {
      available[v] = all[v];
      log.info("Vendor CLI found", { vendor: v, version: health.version });
    } else {
      missing.push({ vendor: v, error: health.error });
      log.warn("Vendor CLI unavailable; the engine won't assign it a role", {
        vendor: v,
        error: health.error,
      });
    }
  }
  return { adapters: bridgeAdapters(available), mock: false, missing };
}
