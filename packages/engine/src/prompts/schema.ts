// The JSON shapes the prompts ask each vendor to return. They mirror the
// output schemas in `core.ts` and the vendor finding in the contracts.

const FINDING_SCHEMA = {
  type: "object",
  required: ["severity", "title", "file", "lines", "failure_case", "category", "introduced"],
  properties: {
    severity: { enum: ["P1", "P2", "P3", "nit"] },
    title: { type: "string", description: "One-line descriptive title." },
    file: { type: "string", description: "Path relative to the repository root." },
    symbol: {
      type: "string",
      description:
        "The function, class, or other symbol the finding is about, when you can name one.",
    },
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
    verdict: {
      enum: ["confirmed", "disproved", "unverified"],
      description:
        "unverified when your tools failed and the code alone doesn't settle the finding.",
    },
    verification: { enum: ["script", "code-reading"] },
    evidence: { type: "string", description: "What you ran or read, and what it showed." },
    presentAtBase: {
      type: "boolean",
      description: "True when the same flaw exists in the base worktree.",
    },
    severity: {
      enum: ["P1", "P2", "P3", "nit"],
      description:
        "For a confirmed finding only: its severity by the severity anchors, when it differs from the reported one. Omit to keep the reported severity.",
    },
    script: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Relative to the scratch directory." },
            interpreter: { type: "string", description: "Such as python3, node, or bash." },
            content: {
              type: "string",
              description:
                "The script's text, when you couldn't write the file. The engine writes it to path.",
            },
          },
        },
      ],
    },
  },
} as const;

export const VERIFY_BATCH_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      description: "One entry for each finding id you were given.",
      items: {
        type: "object",
        required: ["id", ...VERIFY_OUTPUT_JSON_SCHEMA.required],
        properties: {
          id: { type: "string", description: "The finding id." },
          ...VERIFY_OUTPUT_JSON_SCHEMA.properties,
        },
      },
    },
  },
} as const;

export const CLUSTER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  required: ["causes", "rationale"],
  properties: {
    causes: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "summary", "findingIds", "fixOrder"],
        properties: {
          title: { type: "string", description: "Short name of the root cause. Max 80 chars." },
          summary: {
            type: "string",
            description: "What the findings share and the fix. Max 200 chars.",
          },
          findingIds: { type: "array", items: { type: "string", description: "Finding id." } },
          fixOrder: { type: "integer", minimum: 1, description: "1 is the first fix." },
        },
      },
    },
    rationale: { type: "string", description: "Why this fix order. Max 200 chars." },
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

/**
 * The longest each text field can be at the `standard` depth, in characters.
 * Agents read these fields, so they carry claims and facts, not narration. The
 * limits are guidance: the engine doesn't cut a field that decides a verdict.
 */
export const TERSE_LIMITS = {
  title: 80,
  failureCase: 160,
  evidence: 200,
  reason: 100,
  summary: 200,
} as const;

const TERSE_FINDING_SCHEMA = {
  ...FINDING_SCHEMA,
  properties: {
    ...FINDING_SCHEMA.properties,
    title: { type: "string", description: `Short claim. Max ${TERSE_LIMITS.title} chars.` },
    file: { type: "string", description: "Repo-relative path." },
    symbol: { type: "string" },
    lines: { ...FINDING_SCHEMA.properties.lines, description: "First, last, in the tip." },
    failure_case: {
      type: "string",
      description: `input > wrong result. Max ${TERSE_LIMITS.failureCase} chars.`,
    },
    category: {
      type: "string",
      description:
        "correctness, error-handling, security, data-exposure, resource, performance, concurrency, or maintainability.",
    },
    introduced: { type: "boolean", description: "False if at base." },
  },
} as const;

const TERSE_REASON = { type: "string", description: `Max ${TERSE_LIMITS.reason} chars.` } as const;

export const TERSE_REVIEW_SCHEMA = {
  ...REVIEW_OUTPUT_JSON_SCHEMA,
  properties: {
    findings: { type: "array", items: TERSE_FINDING_SCHEMA },
    ledger: {
      type: "array",
      items: {
        ...REVIEW_OUTPUT_JSON_SCHEMA.properties.ledger.items,
        properties: {
          hunkId: { type: "string" },
          verdict: { enum: ["findings", "sound"] },
          reason: TERSE_REASON,
        },
      },
    },
  },
} as const;

export const TERSE_SWEEP_SCHEMA = {
  ...SWEEP_OUTPUT_JSON_SCHEMA,
  properties: { findings: { type: "array", items: TERSE_FINDING_SCHEMA } },
} as const;

const TERSE_VERIFY_PROPERTIES = {
  ...VERIFY_OUTPUT_JSON_SCHEMA.properties,
  evidence: {
    type: "string",
    description: `file:line and a minimal fact. Max ${TERSE_LIMITS.evidence} chars.`,
  },
  presentAtBase: { type: "boolean" },
} as const;

export const TERSE_VERIFY_SCHEMA = {
  ...VERIFY_OUTPUT_JSON_SCHEMA,
  properties: TERSE_VERIFY_PROPERTIES,
} as const;

export const TERSE_VERIFY_BATCH_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["id", ...VERIFY_OUTPUT_JSON_SCHEMA.required],
        properties: { id: { type: "string" }, ...TERSE_VERIFY_PROPERTIES },
      },
    },
  },
} as const;

const TERSE_REASONS = {
  type: "array",
  items: {
    type: "object",
    required: ["id", "reason"],
    properties: { id: { type: "string" }, reason: TERSE_REASON },
  },
} as const;

export const TERSE_FIX_SCHEMA = {
  ...FIX_OUTPUT_JSON_SCHEMA,
  properties: {
    fixed: { type: "array", items: { type: "string" } },
    notFixed: TERSE_REASONS,
    summary: { type: "string", description: `Max ${TERSE_LIMITS.summary} chars.` },
  },
} as const;

export const TERSE_CONFIRM_SCHEMA = {
  ...CONFIRM_OUTPUT_JSON_SCHEMA,
  properties: {
    incomplete: TERSE_REASONS,
    findings: { type: "array", items: TERSE_FINDING_SCHEMA },
  },
} as const;

/** The closing instruction of a compact prompt: the schema on one line. */
export function terseJsonInstruction(schema: object): string {
  return `Answer with one JSON object and nothing else, no code fence. Schema: ${JSON.stringify(schema)}`;
}

/** The closing instruction of every prompt: answer with one JSON object of this schema. */
export function jsonInstruction(schema: object): string {
  return [
    "Answer with exactly one JSON object and nothing else: no prose before or after it, no code fence.",
    "It must match this JSON schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}
