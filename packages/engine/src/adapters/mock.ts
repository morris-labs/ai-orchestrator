// An adapter that replays scripted responses, for engine tests and app demos.
// It runs no process.
import { readFileSync } from "node:fs";
import { UsageSampleSchema, VendorSchema, type Vendor } from "@agentbox/contracts";
import { z } from "zod";
import { parseStructured } from "./output.js";
import {
  AdapterError,
  METHOD_ROLES,
  type AdapterHealth,
  type AdapterMethod,
  type CliRequest,
  type CliResult,
  type CliLimitInfo,
  type CliVendorAdapter,
} from "./types.js";

const MethodSchema = z.enum(["review", "continueReview", "verify", "fix", "confirm", "sweep"]);

const LimitInfoSchema = z.object({
  kind: z.enum(["usage_limit", "rate_limit"]),
  resetAt: z.string().datetime({ offset: true }).nullable().default(null),
  message: z.string().default("Scripted limit."),
});

export const MockResponseSchema = z.object({
  /** Answers only this method. Absent answers any. */
  method: MethodSchema.optional(),
  /** A regular expression the prompt must match. */
  match: z.string().optional(),
  /** How many calls this response answers. Absent means every matching call. */
  times: z.number().int().positive().optional(),
  output: z.unknown().optional(),
  sessionId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  tokens: z
    .object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
    .default({ input: 0, output: 0 }),
  costUsd: z.number().nonnegative().optional(),
  premiumRequests: z.number().nonnegative().default(0),
  usage: z.array(UsageSampleSchema).default([]),
  delayMs: z.number().int().nonnegative().default(0),
  /** Makes the call fail with an `AdapterError` of this kind. */
  error: z
    .object({
      kind: z.enum(["limit", "auth", "timeout", "cancelled", "output", "process", "unavailable"]),
      message: z.string().default("Scripted failure."),
      limit: LimitInfoSchema.optional(),
    })
    .optional(),
});
export type MockResponse = z.infer<typeof MockResponseSchema>;

export const MockScriptSchema = z.object({
  vendor: VendorSchema,
  /** What `health()` reports. Default available, version `mock`. */
  health: z.object({ available: z.boolean(), version: z.string().nullable() }).optional(),
  responses: z.array(MockResponseSchema),
});
export type MockScript = z.infer<typeof MockScriptSchema>;
export type MockScriptInput = z.input<typeof MockScriptSchema>;

/** One call the mock received. */
export interface MockCall {
  method: AdapterMethod;
  role: (typeof METHOD_ROLES)[AdapterMethod];
  request: CliRequest<unknown>;
  /** Index of the response that answered, or -1. */
  responseIndex: number;
}

export class MockAdapter implements CliVendorAdapter {
  readonly vendor: Vendor;
  readonly calls: MockCall[] = [];
  private readonly script: MockScript;
  private readonly used: number[];

  constructor(script: MockScriptInput) {
    this.script = MockScriptSchema.parse(script);
    this.vendor = this.script.vendor;
    this.used = this.script.responses.map(() => 0);
  }

  /** Loads a script from a JSON file. */
  static fromFile(path: string): MockAdapter {
    return new MockAdapter(JSON.parse(readFileSync(path, "utf8")) as MockScriptInput);
  }

  review<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.answer("review", req);
  }
  continueReview<T>(req: CliRequest<T> & { sessionId: string }): Promise<CliResult<T>> {
    return this.answer("continueReview", req);
  }
  verify<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.answer("verify", req);
  }
  fix<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.answer("fix", req);
  }
  confirm<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.answer("confirm", req);
  }
  sweep<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.answer("sweep", req);
  }

  detectLimit(error: unknown): CliLimitInfo | null {
    return error instanceof AdapterError ? error.limit : null;
  }

  health(): Promise<AdapterHealth> {
    const h = this.script.health ?? { available: true, version: "mock" };
    return Promise.resolve({
      vendor: this.vendor,
      ...h,
      error: h.available ? null : "Scripted as unavailable.",
    });
  }

  /** How many scripted responses still have uses left; unlimited ones count as one. */
  remaining(): number {
    return this.script.responses.filter(
      (r, i) => r.times === undefined || (this.used[i] ?? 0) < r.times,
    ).length;
  }

  private async answer<T>(method: AdapterMethod, req: CliRequest<T>): Promise<CliResult<T>> {
    const index = this.script.responses.findIndex(
      (r, i) =>
        (r.method === undefined || r.method === method) &&
        (r.match === undefined || new RegExp(r.match).test(req.prompt)) &&
        (r.times === undefined || (this.used[i] ?? 0) < r.times),
    );
    this.calls.push({
      method,
      role: METHOD_ROLES[method],
      request: req as CliRequest<unknown>,
      responseIndex: index,
    });
    const response = this.script.responses[index];
    if (!response) {
      throw new AdapterError(
        this.vendor,
        "process",
        `The mock ${this.vendor} script has no response for ${method}.`,
      );
    }
    this.used[index] = (this.used[index] ?? 0) + 1;

    const started = Date.now();
    if (response.delayMs > 0) await delay(response.delayMs, req, this.vendor);

    const sessionId =
      response.sessionId === undefined
        ? (req.sessionId ?? `mock-${this.vendor}-${this.calls.length}`)
        : response.sessionId;
    const raw = JSON.stringify(response.output ?? null);
    if (response.error) {
      const limit =
        response.error.kind === "limit"
          ? (response.error.limit ?? {
              kind: "usage_limit" as const,
              resetAt: null,
              message: response.error.message,
            })
          : null;
      throw new AdapterError(this.vendor, response.error.kind, response.error.message, {
        limit,
        raw,
        sessionId,
      });
    }
    for (const sample of response.usage) req.onUsage?.(sample);
    return {
      output: parseStructured(this.vendor, req.outputSchema, response.output, raw, sessionId),
      sessionId,
      model: response.model === undefined ? (req.model ?? null) : response.model,
      usage: response.usage,
      tokens: response.tokens,
      costUsd: response.costUsd,
      premiumRequests: response.premiumRequests,
      raw,
      durationMs: Date.now() - started,
    };
  }
}

function delay(ms: number, req: CliRequest<unknown>, vendor: Vendor): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms > req.timeoutMs) {
      setTimeout(
        () => reject(new AdapterError(vendor, "timeout", "The scripted delay passed the timeout.")),
        req.timeoutMs,
      );
      return;
    }
    const timer = setTimeout(resolve, ms);
    req.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AdapterError(vendor, "cancelled", "The call was cancelled."));
      },
      { once: true },
    );
  });
}
