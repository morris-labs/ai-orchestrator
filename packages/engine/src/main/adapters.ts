// Picks the vendor adapters the engine runs with: the real CLIs that answer
// `--version`, or scripted mocks for the vendors `AIO_MOCK_VENDORS` names.
import { readFileSync } from "node:fs";
import { VendorSchema, type Vendor } from "@aio/contracts";
import { z } from "zod";
import type { Logger } from "../api/core-interface.js";
import { bridgeAdapters } from "../adapters/bridge.js";
import { createAdapters } from "../adapters/index.js";
import { MockAdapter, MockResponseSchema, type MockResponse } from "../adapters/mock.js";
import type { CliVendorAdapter } from "../adapters/types.js";
import type { AdapterSet } from "../core.js";

/**
 * The vendors whose calls a script answers instead of a CLI: `1` for every
 * vendor, or a comma-separated list such as `codex,copilot`.
 */
export const MOCK_VENDORS_ENV = "AIO_MOCK_VENDORS";
/** A JSON file with a `responses` list per vendor, for the vendors `AIO_MOCK_VENDORS` mocks. */
export const MOCK_SCRIPT_ENV = "AIO_MOCK_SCRIPT";

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

/**
 * Reads `AIO_MOCK_VENDORS`: `1` mocks every vendor, a comma-separated
 * list mocks those vendors, and an absent, empty, or `0` value mocks none.
 * Throws for a name that isn't a vendor.
 */
export function parseMockVendors(value: string | undefined): Vendor[] {
  const text = (value ?? "").trim();
  if (text === "" || text === "0") return [];
  if (text === "1") return [...VENDORS];
  const out: Vendor[] = [];
  for (const name of text.split(",").map((n) => n.trim().toLowerCase())) {
    if (name === "") continue;
    const parsed = VendorSchema.safeParse(name);
    if (!parsed.success) {
      throw new Error(
        `${MOCK_VENDORS_ENV} names an unknown vendor "${name}". Use 1 or a list of ${VENDORS.join(", ")}.`,
      );
    }
    if (!out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}

export interface SelectedAdapters {
  adapters: AdapterSet;
  /** True when every vendor answers from a mock script. */
  mock: boolean;
  /** The vendors that answer from a mock script. */
  mocked: Vendor[];
  /** Vendors left out because their CLI didn't answer. */
  missing: Array<{ vendor: Vendor; error: string | null }>;
}

/** Returns the adapters for the engine's environment. */
export async function selectAdapters(
  env: Record<string, string | undefined>,
  log: Logger,
  candidates: () => Record<Vendor, CliVendorAdapter> = () => createAdapters(),
): Promise<SelectedAdapters> {
  const mocked = parseMockVendors(env[MOCK_VENDORS_ENV]);
  const script = env[MOCK_SCRIPT_ENV] || undefined;
  const mocks = mocked.length > 0 ? createMockAdapters(script) : null;
  if (mocks) {
    log.warn("Vendor calls answer from mock scripts", {
      vendors: mocked.join(","),
      script: script ?? "built-in",
    });
  }
  if (mocked.length === VENDORS.length && mocks) {
    return { adapters: bridgeAdapters(mocks), mock: true, mocked, missing: [] };
  }
  const real = VENDORS.filter((v) => !mocked.includes(v));
  const all = candidates();
  const checks = await Promise.all(real.map(async (v) => ({ v, health: await all[v].health() })));
  const available: Partial<Record<Vendor, CliVendorAdapter>> = {};
  for (const v of mocked) if (mocks) available[v] = mocks[v];
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
  return { adapters: bridgeAdapters(available), mock: false, mocked, missing };
}
