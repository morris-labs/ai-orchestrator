import { describe, expect, it } from "vitest";
import { dropNulls, extractJson, extractJsonCandidates } from "../../src/adapters/json.js";

describe("extractJsonCandidates", () => {
  it("returns a whole-text object as the only candidate", () => {
    expect(extractJsonCandidates(' {"a":1} ')).toEqual([{ a: 1 }]);
  });

  it("finds objects and arrays inside prose and fences", () => {
    const text = 'Draft: {"a":1}\n```json\n{"b":[1,2]}\n```\nAlso [3]';
    expect(extractJsonCandidates(text)).toEqual([{ a: 1 }, { b: [1, 2] }, [3]]);
  });

  it("ignores brackets inside strings and skips broken JSON", () => {
    const text = 'see {not json} then {"t":"a } and { inside","n":2}';
    expect(extractJsonCandidates(text)).toEqual([{ t: "a } and { inside", n: 2 }]);
  });

  it("handles escaped quotes", () => {
    expect(extractJsonCandidates('x {"q":"say \\"hi\\" }"} y')).toEqual([{ q: 'say "hi" }' }]);
  });
});

describe("extractJson", () => {
  it("prefers the last candidate", () => {
    expect(extractJson('{"a":1} and finally {"a":2}')).toEqual({ a: 2 });
  });

  it("returns the last candidate the predicate accepts", () => {
    const value = extractJson(
      '{"findings":[]} then {"other":1}',
      (v) => typeof v === "object" && v !== null && "findings" in v,
    );
    expect(value).toEqual({ findings: [] });
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
  });

  it("throws when nothing has the expected shape", () => {
    expect(() => extractJson('{"a":1}', () => false)).toThrow(/expected shape/);
  });
});

describe("dropNulls", () => {
  it("removes null properties recursively and keeps array entries", () => {
    expect(dropNulls({ a: null, b: { c: null, d: 1 }, e: [null, { f: null }] })).toEqual({
      b: { d: 1 },
      e: [null, {}],
    });
  });
});
