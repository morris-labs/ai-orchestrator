import { describe, expect, it } from "vitest";
import {
  changedCode,
  changedSymbols,
  changesExport,
  isDocOrLockfile,
  isSchemaPath,
  languageOf,
  riskyChange,
} from "../../src/group/symbols.js";

const hunk = (...lines: string[]) => ["@@ -1 +1 @@", ...lines];

describe("changedSymbols", () => {
  it.each([
    ["js", " export function chargeCard(a) {", "+  a();", "chargeCard"],
    ["js", " class Ledger {", "+  x = 1;", "Ledger"],
    ["python", " def charge_card(a):", "+    a()", "charge_card"],
    ["go", " func (s *Shop) ChargeCard() {", "+\ts()", "ChargeCard"],
    ["java", " public void chargeCard(int a) {", "+  a();", "chargeCard"],
    ["c", " int charge_card(int a) {", "+  a();", "charge_card"],
    ["shell", " charge_card() {", "+  a", "charge_card"],
  ] as const)("%s reads %s", (language, def, change, symbol) => {
    expect(changedSymbols(language, hunk(def, change))).toEqual([symbol]);
  });

  it("skips short names, the stoplist in any case, and blank lines", () => {
    expect(changedSymbols("js", hunk(" function ab() {", "+ x();"))).toEqual([]);
    expect(changedSymbols("js", hunk(" function render() {", "+ x();"))).toEqual([]);
    expect(changedSymbols("java", hunk(" public String toString() {", "+ x();"))).toEqual([]);
    expect(changedSymbols("js", hunk(" constructor(a) {", "+ x();"))).toEqual([]);
    expect(changedSymbols("js", hunk(" function chargeCard() {", "+   "))).toEqual([]);
  });

  it.each([
    ["if", " function chargeCard(a) {", "   if (a) {"],
    ["for", " function chargeCard(a) {", "   for (x of y) {"],
    ["a local const", " function chargeCard(a) {", "   const amount = 1;"],
  ])("keeps the enclosing function past %s", (_name, def, inner) => {
    expect(changedSymbols("js", hunk(def, inner, "+    x();"))).toEqual(["chargeCard"]);
  });

  it("keeps the enclosing C function past a local struct variable", () => {
    expect(changedSymbols("c", hunk(" int charge_card(int a) {", "   struct point p;", "+  x();"))).toEqual(
      ["charge_card"],
    );
  });

  it.each([
    ["js", " export const enum Color {", "+ A,", "Color"],
    ["js", " onCharge: async (a) => {", "+ x();", "onCharge"],
    ["c", " enum class Color {", "+ A,", "Color"],
    ["c", " class MYLIB_API Ledger {", "+ int a;", "Ledger"],
    ["python", " MAX_RETRIES = 3", "+MAX_RETRIES = 4", "MAX_RETRIES"],
    ["go", " var Timeout = 3", "+var Timeout = 4", "Timeout"],
    ["java", " Ledger(int a) {", "+ x();", "Ledger"],
  ] as const)("%s reads a definition from %s", (language, def, change, symbol) => {
    const got = changedSymbols(language, hunk(def, change));
    expect(got).toContain(symbol);
  });

  it("doesn't cap the symbols of a file by spelling", () => {
    const lines = Array.from({ length: 30 }, (_, i) => [
      ` function symbol${String(i).padStart(2, "0")}() {`,
      "+ x();",
    ]).flat();
    expect(changedSymbols("js", hunk(...lines))).toHaveLength(30);
  });

  it("takes the nearest definition, not every one in the hunk", () => {
    expect(
      changedSymbols("python", hunk(" def first_one():", "  pass", " def second_one():", "-  a")),
    ).toEqual(["second_one"]);
  });
});

describe("languageOf", () => {
  it("knows the listed languages and nothing else", () => {
    expect(languageOf("a.tsx")).toBe("js");
    expect(languageOf("a.hpp")).toBe("c");
    expect(languageOf("a.rs")).toBeNull();
  });
});

describe("changed-code signals", () => {
  it("finds exports", () => {
    expect(changesExport("a.ts", "js", ["export const a = 1;"])).toBe(true);
    expect(changesExport("a.ts", "js", ["const a = 1;"])).toBe(false);
    expect(changesExport("a.go", "go", ["func Charge() {"])).toBe(true);
    expect(changesExport("a.go", "go", ["func charge() {"])).toBe(false);
    expect(changesExport("a.rs", null, ["pub fn a() {}"])).toBe(false);
  });

  it("finds risky code and leaves plain code alone", () => {
    expect(riskyChange("a.ts", ["await Promise.all(x);"])).toBe("concurrency");
    expect(riskyChange("a.ts", ["const v = JSON.parse(t);"])).toBe("parsing");
    expect(riskyChange("db/migrations/1.sql", [])).toBe("migrations");
    expect(riskyChange("a.ts", ["await x();"])).toBeNull();
  });

  it("reads every changed line that isn't blank", () => {
    expect(changedCode(hunk("+  ", "+*out = a();", " b();"))).toEqual(["*out = a();"]);
  });

  it("finds more export forms and ignores a header's statements", () => {
    expect(changesExport("a.js", "js", ["module.exports = {};"])).toBe(true);
    expect(changesExport("a.js", "js", ["exports.a = 1;"])).toBe(true);
    expect(changesExport("a.go", "go", ["\tFoo = 1"])).toBe(true);
    expect(changesExport("a.go", "go", ["\tDoThing()"])).toBe(false);
    expect(changesExport("a.py", "python", ["    def charge(self):"])).toBe(true);
    expect(changesExport("a.py", "python", ["__all__ = []"])).toBe(true);
    expect(changesExport("a.h", "c", ["#define A 1"])).toBe(true);
    expect(changesExport("a.h", "c", ["  return foo(x);"])).toBe(false);
    expect(changesExport("a.h", "c", ["typedef int a_t;"])).toBe(true);
  });

  it("finds more risky forms and leaves number conversion alone", () => {
    expect(riskyChange("a.go", ["go s.run()"])).toBe("concurrency");
    expect(riskyChange("a.go", ["\tselect {"])).toBe("concurrency");
    expect(riskyChange("a.py", ["x = json.loads(t)"])).toBe("parsing");
    expect(riskyChange("a.ts", ["const n = parseInt(x);"])).toBeNull();
    expect(riskyChange("a.ts", ["const n = parseFloat(x);"])).toBeNull();
    expect(riskyChange("db/migrate/1.rb", [])).toBe("migrations");
    expect(riskyChange("alembic/versions/1.py", [])).toBe("migrations");
  });

  it("classifies paths without trusting the folder", () => {
    expect(isDocOrLockfile("README.md")).toBe(true);
    expect(isDocOrLockfile("pnpm-lock.yaml")).toBe(true);
    expect(isDocOrLockfile("docs/conf.py")).toBe(false);
    expect(isDocOrLockfile("requirements.txt")).toBe(false);
    expect(isSchemaPath("api/orders.proto")).toBe(true);
    expect(isSchemaPath("src/orders.ts")).toBe(false);
    expect(isSchemaPath("db/orders.sql")).toBe(true);
    expect(isSchemaPath("src/schema.ts")).toBe(true);
    expect(isSchemaPath("src/useSchemaForm.tsx")).toBe(false);
    expect(isSchemaPath("src/schematic.py")).toBe(false);
  });

  it.each([
    ["CLAUDE.md", false],
    ["sub/AGENTS.md", false],
    ["CLAUDE.local.md", false],
    ["SKILL.md", false],
    [".github/copilot-instructions.md", false],
    ["review.prompt.md", false],
    ["packages/x/prompts/review.md", false],
    ["skills/a/notes.md", false],
    ["guide.mdx", false],
    ["notes.txt", false],
    ["requirements/dev.txt", false],
    ["docs/guide.md", true],
    ["README", true],
    ["LICENSE.txt", true],
    ["go.sum", true],
  ])("%s is small by path: %s", (path, small) => {
    expect(isDocOrLockfile(path)).toBe(small);
  });
});
