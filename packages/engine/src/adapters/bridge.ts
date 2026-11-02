// Turns a CLI adapter (`CliVendorAdapter`) into the engine core's
// `VendorAdapter`. The core asks for a role's output shape by method; the CLI
// adapter takes any schema, so the bridge picks the schema, maps the request
// and result field names, and leaves the CLI behavior to the adapter.
import { assertReviewModelAllowed, type Vendor } from "@aio/contracts";
import type { z } from "zod";
import {
  ConfirmOutputSchema,
  FixOutputSchema,
  ReviewOutputSchema,
  SweepOutputSchema,
  VerifyOutputSchema,
  type AdapterMethod,
  type AdapterRequest,
  type AdapterResult,
  type AdapterSet,
  type ContinueRequest,
  type LimitInfo,
  type RawUsageSample,
  type VendorAdapter,
} from "../core.js";
import {
  CONFIRM_OUTPUT_JSON_SCHEMA,
  FIX_OUTPUT_JSON_SCHEMA,
  REVIEW_OUTPUT_JSON_SCHEMA,
  SWEEP_OUTPUT_JSON_SCHEMA,
  VERIFY_OUTPUT_JSON_SCHEMA,
} from "../prompts/schema.js";
import { isRetryable } from "./retry.js";
import { AdapterError, type CliRequest, type CliResult, type CliVendorAdapter } from "./types.js";

interface MethodSchema {
  output: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  /** The JSON Schema the prompts in `src/prompts` show the vendor. */
  json: Record<string, unknown>;
}

/** The output schema each core method parses, and the JSON Schema the CLI gets. */
export const METHOD_SCHEMAS: Record<AdapterMethod, MethodSchema> = {
  review: { output: ReviewOutputSchema, json: REVIEW_OUTPUT_JSON_SCHEMA },
  continueReview: { output: ReviewOutputSchema, json: REVIEW_OUTPUT_JSON_SCHEMA },
  verify: { output: VerifyOutputSchema, json: VERIFY_OUTPUT_JSON_SCHEMA },
  fix: { output: FixOutputSchema, json: FIX_OUTPUT_JSON_SCHEMA },
  confirm: { output: ConfirmOutputSchema, json: CONFIRM_OUTPUT_JSON_SCHEMA },
  sweep: { output: SweepOutputSchema, json: SWEEP_OUTPUT_JSON_SCHEMA },
};

/** Maps a core request to a CLI request for `method`. */
export function toCliRequest(
  method: AdapterMethod,
  request: AdapterRequest | ContinueRequest,
): CliRequest<unknown> {
  const schema = METHOD_SCHEMAS[method];
  const addDirs = [
    ...(request.extraDirs ?? []),
    ...(request.scratchDir ? [request.scratchDir] : []),
  ];
  return {
    prompt: request.prompt,
    cwd: request.repoPath,
    ...(addDirs.length > 0 ? { addDirs } : {}),
    ...(request.scratchDir ? { scratchDir: request.scratchDir } : {}),
    tools: request.toolPolicy,
    timeoutMs: request.timeoutMs,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...("sessionId" in request ? { sessionId: request.sessionId } : {}),
    outputSchema: schema.output,
    jsonSchema: schema.json,
  };
}

/**
 * Maps a CLI result to a core result. The CLI adapter stamps a ceiling on
 * each usage sample; the core stamps the ceiling in force, so the bridge
 * drops it. A missing model falls back to the requested one, then the
 * vendor name.
 */
export function toCoreResult<T>(
  vendor: Vendor,
  result: CliResult<unknown>,
  requestedModel: string | undefined,
): AdapterResult<T> {
  const usage: RawUsageSample[] = result.usage.map(({ ceiling: _ceiling, ...sample }) => sample);
  return {
    output: result.output as T,
    model: result.model ?? requestedModel ?? vendor,
    sessionId: result.sessionId,
    tokens: { in: result.tokens.input, out: result.tokens.output },
    usage,
    premiumRequests: result.premiumRequests,
    ...(result.aiCredits !== undefined ? { aiCredits: result.aiCredits } : {}),
    costEstimate: result.costUsd ?? 0,
    ...(result.toolErrors?.length ? { toolErrors: result.toolErrors } : {}),
  };
}

/** The core's view of one CLI adapter. */
export class BridgedAdapter implements VendorAdapter {
  readonly vendor: Vendor;

  constructor(readonly cli: CliVendorAdapter) {
    this.vendor = cli.vendor;
  }

  review(request: AdapterRequest) {
    return this.call<z.infer<typeof ReviewOutputSchema>>("review", request);
  }

  continueReview(request: ContinueRequest) {
    return this.call<z.infer<typeof ReviewOutputSchema>>("continueReview", request);
  }

  verify(request: AdapterRequest) {
    return this.call<z.infer<typeof VerifyOutputSchema>>("verify", request);
  }

  fix(request: AdapterRequest) {
    return this.call<z.infer<typeof FixOutputSchema>>("fix", request);
  }

  confirm(request: AdapterRequest) {
    return this.call<z.infer<typeof ConfirmOutputSchema>>("confirm", request);
  }

  sweep(request: AdapterRequest) {
    return this.call<z.infer<typeof SweepOutputSchema>>("sweep", request);
  }

  detectLimit(error: unknown): LimitInfo | null {
    return this.cli.detectLimit(error);
  }

  /**
   * An `AdapterError` is retried only for the kinds `isRetryable()` names;
   * any other error, such as the core's own call timeout, gets its retry.
   */
  isRetryable(error: unknown): boolean {
    return !(error instanceof AdapterError) || isRetryable(error);
  }

  private async call<T>(
    method: AdapterMethod,
    request: AdapterRequest | ContinueRequest,
  ): Promise<AdapterResult<T>> {
    // The last gate before a CLI: no path reaches a vendor with a blocked model.
    assertReviewModelAllowed(this.vendor, request.model);
    const cli = toCliRequest(method, request);
    const result =
      method === "continueReview"
        ? await this.cli.continueReview({
            ...cli,
            sessionId: (request as ContinueRequest).sessionId,
          })
        : await this.cli[method](cli);
    return toCoreResult<T>(this.vendor, result, request.model);
  }
}

/** Bridges every CLI adapter in `adapters`. */
export function bridgeAdapters(adapters: Partial<Record<Vendor, CliVendorAdapter>>): AdapterSet {
  const out: AdapterSet = {};
  for (const [vendor, cli] of Object.entries(adapters) as [Vendor, CliVendorAdapter][]) {
    out[vendor] = new BridgedAdapter(cli);
  }
  return out;
}
