// Validates structured output against the caller's schema and the contract's
// vendor finding schema, and derives the JSON Schema the CLIs take.
import { VendorFindingSchema, type VendorFinding, type Vendor } from "@agentbox/contracts";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { dropNulls, extractJson } from "./json.js";
import { AdapterError } from "./types.js";

/** The reviewer output wrapper: `{ "findings": [...] }`. */
export const VendorFindingsOutputSchema = z.object({
  findings: z.array(VendorFindingSchema),
});
export type VendorFindingsOutput = z.infer<typeof VendorFindingsOutputSchema>;

export interface FindingIssue {
  index: number;
  message: string;
}

export interface FindingsValidation {
  findings: VendorFinding[];
  /** Entries that failed the contract schema, with the reason. */
  invalid: FindingIssue[];
}

/**
 * Checks each entry of a findings list against `VendorFindingSchema`. It
 * accepts a bare array or an object with a `findings` array, keeps the valid
 * entries, and reports the rest, so one malformed finding doesn't discard a
 * reviewer's whole answer.
 */
export function validateVendorFindings(value: unknown): FindingsValidation {
  const list = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === "object" &&
        Array.isArray((value as { findings?: unknown }).findings)
      ? (value as { findings: unknown[] }).findings
      : null;
  if (list === null) {
    return {
      findings: [],
      invalid: [{ index: -1, message: "expected an array of findings or { findings: [...] }" }],
    };
  }
  const findings: VendorFinding[] = [];
  const invalid: FindingIssue[] = [];
  list.forEach((entry, index) => {
    let result = VendorFindingSchema.safeParse(entry);
    if (!result.success) result = VendorFindingSchema.safeParse(dropNulls(entry));
    if (result.success) findings.push(result.data);
    else invalid.push({ index, message: formatIssues(result.error) });
  });
  return { findings, invalid };
}

/**
 * Parses a value with `schema`. A strict JSON Schema makes models send `null`
 * for optional fields, so a failed parse is retried with nulls removed.
 */
export function parseStructured<T>(
  vendor: Vendor,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  raw: string,
  sessionId: string | null = null,
): T {
  const first = schema.safeParse(value);
  if (first.success) return first.data;
  const second = schema.safeParse(dropNulls(value));
  if (second.success) return second.data;
  throw new AdapterError(
    vendor,
    "output",
    `The ${vendor} output doesn't match the schema: ${formatIssues(first.error)}`,
    {
      raw,
      sessionId,
    },
  );
}

/** Extracts JSON from model text and parses it with `schema`. */
export function parseStructuredText<T>(
  vendor: Vendor,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  text: string,
  raw: string,
  sessionId: string | null = null,
): T {
  let value: unknown;
  try {
    value = extractJson(
      text,
      (v) => schema.safeParse(v).success || schema.safeParse(dropNulls(v)).success,
    );
  } catch {
    try {
      value = extractJson(text);
    } catch (err) {
      throw new AdapterError(vendor, "output", `The ${vendor} output holds no JSON answer.`, {
        raw,
        sessionId,
        cause: err,
      });
    }
  }
  return parseStructured(vendor, schema, value, raw, sessionId);
}

/** A plain JSON Schema for `schema`, with no `$ref` and no `$schema` key. */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return normalizeTuples(json) as Record<string, unknown>;
}

/**
 * Rewrites draft-07 tuples (`items` as an array) into a form that draft
 * 2020-12 and OpenAI structured outputs both accept. A tuple of identical
 * item schemas, such as `lines: [start, end]`, becomes a fixed-length array;
 * any other tuple uses `prefixItems`.
 */
function normalizeTuples(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeTuples);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = normalizeTuples(value);
  if (Array.isArray(out.items)) {
    const items = out.items as unknown[];
    delete out.additionalItems;
    const first = JSON.stringify(items[0]);
    if (items.length > 0 && items.every((item) => JSON.stringify(item) === first)) {
      out.items = items[0];
    } else {
      delete out.items;
      out.prefixItems = items;
      out.items = false;
    }
    out.minItems = items.length;
    out.maxItems = items.length;
  }
  return out;
}

/**
 * Rewrites a JSON Schema into the strict form that OpenAI structured outputs
 * require: every object lists all its properties as required, forbids extra
 * properties, and an optional property becomes nullable.
 */
export function toStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return strictNode(schema) as Record<string, unknown>;
}

function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (node === null || typeof node !== "object") return node;
  const input = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "default") continue;
    out[key] = strictNode(value);
  }
  if (input.type === "object" && input.properties && typeof input.properties === "object") {
    const props = out.properties as Record<string, unknown>;
    const required = new Set(Array.isArray(input.required) ? (input.required as string[]) : []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) props[key] = { anyOf: [props[key], { type: "null" }] };
    }
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
