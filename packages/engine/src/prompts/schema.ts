// The JSON shapes the prompts ask each vendor to return. They mirror the
// output schemas in `core.ts` and the vendor finding in the contracts.

const FINDING_SCHEMA = {
  type: "object",
  required: ["severity", "title", "file", "lines", "failure_case", "category", "introduced"],
  properties: {
    severity: { enum: ["P1", "P2", "P3", "nit"] },
    title: { type: "string", description: "One-line descriptive title." },
    file: { type: "string", description: "Path relative to the repository root." },
    lines: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      minItems: 2,
      maxItems: 2,
      description: "First and last line, inclusive, in the tip version of the file.",
    },
    failure_case: {
      type: "string",
      description: "Input X or state Y leads to incorrect behavior Z.",
    },
    category: {
      type: "string",
      description:
        "correctness, error-handling, security, data-exposure, resource, performance, concurrency, or maintainability.",
    },
    introduced: {
      type: "boolean",
      description: "True when the change under review introduced the flaw.",
    },
  },
} as const;

export const REVIEW_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["findings", "ledger"],
  properties: {
    findings: { type: "array", items: FINDING_SCHEMA },
    ledger: {
      type: "array",
      items: {
        type: "object",
        required: ["hunkId", "verdict", "reason"],
        properties: {
          hunkId: { type: "string" },
          verdict: { enum: ["findings", "sound"] },
          reason: { type: "string", description: "One line." },
        },
      },
    },
  },
} as const;

export const SWEEP_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: { findings: { type: "array", items: FINDING_SCHEMA } },
} as const;

export const VERIFY_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["verdict", "verification", "evidence", "presentAtBase", "script"],
  properties: {
    verdict: { enum: ["confirmed", "disproved"] },
    verification: { enum: ["script", "code-reading"] },
    evidence: { type: "string", description: "What you ran or read, and what it showed." },
    presentAtBase: {
      type: "boolean",
      description: "True when the same flaw exists in the base worktree.",
    },
    script: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Relative to the scratch directory." },
            interpreter: { type: "string", description: "Such as python3, node, or bash." },
          },
        },
      ],
    },
  },
} as const;

export const FIX_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["fixed", "notFixed", "summary"],
  properties: {
    fixed: { type: "array", items: { type: "string", description: "Finding id." } },
    notFixed: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "reason"],
        properties: { id: { type: "string" }, reason: { type: "string" } },
      },
    },
    summary: { type: "string" },
  },
} as const;

export const CONFIRM_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["incomplete", "findings"],
  properties: {
    incomplete: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "reason"],
        properties: { id: { type: "string" }, reason: { type: "string" } },
      },
    },
    findings: { type: "array", items: FINDING_SCHEMA },
  },
} as const;

/** The closing instruction of every prompt: answer with one JSON object of this schema. */
export function jsonInstruction(schema: object): string {
  return [
    "Answer with exactly one JSON object and nothing else: no prose before or after it, no code fence.",
    "It must match this JSON schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}
