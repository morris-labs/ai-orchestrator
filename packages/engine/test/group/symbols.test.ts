import { describe, expect, it } from "vitest";
import {
  changedCode,
  changedSymbols,
  changesExport,
  isDocOrLockfile,
  isSchemaPath,
  languageOf,
  riskyChange,
  sameCode,
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

  it("skips short names, the stoplist, comments, and unsafe names", () => {
    expect(changedSymbols("js", hunk(" function ab() {", "+ x();"))).toEqual([]);
    expect(changedSymbols("js", hunk(" function render() {", "+ x();"))).toEqual([]);
    expect(changedSymbols("js", hunk(" function chargeCard() {", "+ // note"))).toEqual([]);
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

  it("drops comments from changed code", () => {
    expect(changedCode(hunk("+// note", "+a();", " b();"))).toEqual(["a();"]);
  });

  it("classifies paths without trusting the folder", () => {
    expect(isDocOrLockfile("README.md")).toBe(true);
    expect(isDocOrLockfile("pnpm-lock.yaml")).toBe(true);
    expect(isDocOrLockfile("docs/conf.py")).toBe(false);
    expect(isDocOrLockfile("requirements.txt")).toBe(false);
    expect(isSchemaPath("api/orders.proto")).toBe(true);
    expect(isSchemaPath("src/orders.ts")).toBe(false);
  });
});

describe("sameCode", () => {
  it.each([
    ["js", "a(); // one\n", "a(); // two\n", true],
    ["js", "/* one */\na();\n", "a();\n", true],
    ["js", "a(1,2);\n", "a(1,\n  2);\n", true],
    ["js", 'a("x y");\n', 'a("x  y");\n', false],
    ["js", 'a("// x");\n', 'a("// y");\n', false],
    ["js", "int x;\n", "intx;\n", false],
    ["python", "a()  # one\n", "a()  # two\n", true],
    ["python", "if a:\n  b()\n", "if a:\nb()\n", false],
    ["shell", "# one\na\n", "# two\na\n", true],
    [null, "a\n", "a \n", false],
  ] as const)("%s %j and %j: %s", (language, base, tip, same) => {
    expect(sameCode(language, base, tip)).toBe(same);
  });
});
