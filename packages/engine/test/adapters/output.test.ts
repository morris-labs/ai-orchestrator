import { fromVendorFinding } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseStructured,
  parseStructuredText,
  toJsonSchema,
  toStrictJsonSchema,
  validateVendorFindings,
  VendorFindingsOutputSchema,
} from "../../src/adapters/output.js";
import { AdapterError } from "../../src/adapters/types.js";

const finding = {
  severity: "P1",
  title: "Off by one",
  file: "src/a.ts",
  lines: [3, 5],
  failure_case: "Empty input crashes.",
  category: "correctness",
  introduced: true,
};

describe("validateVendorFindings", () => {
  it("accepts a bare array and a wrapped list", () => {
    expect(validateVendorFindings([finding]).findings).toHaveLength(1);
    expect(validateVendorFindings({ findings: [finding] }).findings[0]?.verdict).toBe("pending");
  });

  it("keeps valid entries and reports invalid ones", () => {
    const result = validateVendorFindings([
      finding,
      { ...finding, lines: [5, 3] },
      { ...finding, severity: "P9" },
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.invalid.map((i) => i.index)).toEqual([1, 2]);
  });

  it("accepts nulls for optional fields from a strict schema", () => {
    const result = validateVendorFindings([{ ...finding, evidence: null, verification: null }]);
    expect(result.invalid).toEqual([]);
  });

  it("rejects a value that holds no list", () => {
    expect(validateVendorFindings({ nope: 1 }).invalid[0]?.index).toBe(-1);
  });

  it("produces findings the contract converter accepts", () => {
    const [vf] = validateVendorFindings([finding]).findings;
    const f = fromVendorFinding(vf!, {
      id: "F-0001",
      fingerprint: "abc",
      reportedBy: "codex-gpt",
      runId: "01JAAAAAAAAAAAAAAAAAAAAAAA",
      round: 1,
      groupId: "G-1",
    });
    expect(f.failureCase).toBe("Empty input crashes.");
  });
});

describe("parseStructured", () => {
  it("retries with nulls dropped", () => {
    const schema = z.object({ a: z.number(), b: z.string().optional() });
    expect(parseStructured("codex", schema, { a: 1, b: null }, "")).toEqual({ a: 1 });
  });

  it("throws an output error with the issue path", () => {
    try {
      parseStructured("codex", VendorFindingsOutputSchema, { findings: [{}] }, "raw", "s1");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).kind).toBe("output");
      expect((err as AdapterError).sessionId).toBe("s1");
      expect((err as AdapterError).message).toMatch(/findings\.0/);
    }
  });
});

describe("parseStructuredText", () => {
  it("picks the JSON that fits the schema out of prose", () => {
    const text = `Notes {"x":1}\n${JSON.stringify({ findings: [finding] })}\nDone.`;
    expect(
      parseStructuredText("copilot", VendorFindingsOutputSchema, text, text).findings,
    ).toHaveLength(1);
  });

  it("throws an output error when there is no JSON", () => {
    expect(() =>
      parseStructuredText("copilot", VendorFindingsOutputSchema, "nothing", "nothing"),
    ).toThrow(AdapterError);
  });
});

describe("toJsonSchema", () => {
  it("turns the lines tuple into a fixed-length array", () => {
    const schema = toJsonSchema(VendorFindingsOutputSchema) as {
      properties: { findings: { items: { properties: { lines: Record<string, unknown> } } } };
    };
    const lines = schema.properties.findings.items.properties.lines;
    expect(lines).toMatchObject({
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "integer" },
    });
    expect(Array.isArray(lines.items)).toBe(false);
    expect(schema).not.toHaveProperty("$schema");
  });

  it("uses prefixItems for a mixed tuple", () => {
    const schema = toJsonSchema(z.object({ t: z.tuple([z.string(), z.number()]) })) as {
      properties: { t: Record<string, unknown> };
    };
    expect(schema.properties.t.prefixItems).toHaveLength(2);
    expect(schema.properties.t.items).toBe(false);
  });
});

describe("toStrictJsonSchema", () => {
  it("requires every property, forbids extras, and makes optional ones nullable", () => {
    const strict = toStrictJsonSchema(
      toJsonSchema(
        z.object({ a: z.string(), b: z.number().optional(), c: z.string().default("x") }),
      ),
    );
    expect(strict.required).toEqual(["a", "b", "c"]);
    expect(strict.additionalProperties).toBe(false);
    const props = strict.properties as Record<string, Record<string, unknown>>;
    expect(props.b).toEqual({ anyOf: [{ type: "number" }, { type: "null" }] });
    expect(props.c).not.toHaveProperty("default");
  });

  it("applies to nested objects in arrays", () => {
    const strict = toStrictJsonSchema(toJsonSchema(VendorFindingsOutputSchema)) as {
      properties: { findings: { items: { additionalProperties: boolean; required: string[] } } };
    };
    expect(strict.properties.findings.items.additionalProperties).toBe(false);
    expect(strict.properties.findings.items.required).toContain("evidence");
  });
});
