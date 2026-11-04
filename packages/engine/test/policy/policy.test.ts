import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY, PolicyFileSchema } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { globToRegExp, matchesAny, matchesGlob } from "../../src/policy/glob.js";
import {
  PolicyError,
  loadPolicy,
  parsePolicy,
  parsePolicyExtras,
  policyFilePath,
} from "../../src/policy/load.js";
import { isRiskPath, policyPromptSection, rulesFor } from "../../src/policy/rules.js";
import { tempDir } from "../tmp.js";

describe("glob", () => {
  it.each([
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/**/*.ts", "src/c.ts", true],
    ["src/*.ts", "src/a/c.ts", false],
    ["**/auth/**", "lib/auth/token.py", true],
    ["*.md", "docs/guide.md", true],
    ["src/auth", "src/auth/login.ts", true],
    ["src/auth/", "src/authz.ts", false],
    ["file?.{js,ts}", "dir/file1.ts", true],
    ["[ab].py", "c.py", false],
  ])("%s matches %s: %s", (glob, path, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });

  it("escapes regular expression characters", () => {
    expect(globToRegExp("a+b.c").test("a+b.c")).toBe(true);
    expect(globToRegExp("a+b.c").test("aab_c")).toBe(false);
    expect(matchesAny("x/y.ts", ["*.py", "x/**"])).toBe(true);
  });
});

describe("policy loading", () => {
  it("fills defaults and rejects unknown keys", () => {
    const p = parsePolicy("version: 1\nriskPaths: [src/auth/**]\n");
    expect(p.groupSizeLimit).toBe(400);
    expect(p.riskPaths).toEqual(["src/auth/**"]);
    expect(() => parsePolicy("version: 1\nriskPath: []\n")).toThrow(PolicyError);
    expect(() => parsePolicy("version: 2\n")).toThrow(/version/);
    expect(() => parsePolicy("version: [1\n")).toThrow(PolicyError);
    expect(parsePolicy("")).toEqual(DEFAULT_POLICY);
  });

  it("rejects a malformed glob when the policy loads, not when a prompt is built", () => {
    expect(() =>
      parsePolicy(
        'version: 1\nrules:\n  - id: r1\n    text: t\n    appliesTo: ["src/{auth,api"]\n',
      ),
    ).toThrow(/rules\.0\.appliesTo\.0: The glob src\/\{auth,api has a \{ without its \}/);
    const err = (() => {
      try {
        parsePolicy('version: 1\nriskPaths: ["src/[z-a].ts"]\n');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as Error).message).toMatch(/riskPaths\.0: The glob src\/\[z-a\]\.ts is invalid/);
    expect(parsePolicy('version: 1\nriskPaths: ["src/{auth,api}/**"]\n').riskPaths).toEqual([
      "src/{auth,api}/**",
    ]);
  });

  it("loads the file from the project, or the default when absent", async () => {
    const root = tempDir("aio-policy-");
    expect(await loadPolicy(root)).toEqual(DEFAULT_POLICY);
    mkdirSync(join(root, ".aio"));
    writeFileSync(join(root, ".aio/policy.yaml"), "version: 1\ngroupSizeLimit: 50\n");
    expect((await loadPolicy(root)).groupSizeLimit).toBe(50);
    expect(policyFilePath(root, "/etc/p.yaml")).toBe("/etc/p.yaml");
    expect(policyFilePath("/r")).toBe("/r/.aio/policy.yaml");
  });
});

describe("rules", () => {
  const policy = PolicyFileSchema.parse({
    version: 1,
    riskPaths: ["src/auth/**"],
    rules: [
      { id: "phi", text: "Never log patient data.", appliesTo: ["src/records/**"] },
      { id: "all", text: "Close every file handle." },
    ],
    environmentLimits: ["Windows-only code under win/."],
  });

  it("selects rules by the files in scope", () => {
    expect(rulesFor(policy, ["src/ui/a.ts"]).map((r) => r.id)).toEqual(["all"]);
    expect(rulesFor(policy, ["src/records/a.ts"]).map((r) => r.id)).toEqual(["phi", "all"]);
    expect(rulesFor(policy).map((r) => r.id)).toEqual(["phi", "all"]);
  });

  it("detects risk paths", () => {
    expect(isRiskPath(policy, "src/auth/login.ts")).toBe(true);
    expect(isRiskPath(policy, "src/ui/login.ts")).toBe(false);
  });

  it("renders the prompt section with rules and limits", () => {
    const text = policyPromptSection(policy, ["src/records/x.ts"]);
    expect(text).toContain("[phi] Never log patient data.");
    expect(text).toContain("Windows-only code under win/.");
    expect(policyPromptSection(DEFAULT_POLICY)).toBe("");
  });
});

describe("engine-only policy settings", () => {
  it("reads commentAuthors and keeps the contract schema strict otherwise", () => {
    const text = "version: 1\ncommentAuthors: [alice]\n";
    expect(parsePolicy(text).version).toBe(1);
    expect(parsePolicyExtras(text).commentAuthors).toEqual(["alice"]);
    expect(parsePolicyExtras("version: 1\n").commentAuthors).toBeNull();
    expect(() => parsePolicyExtras("version: 1\ncommentAuthors: 3\n")).toThrow(/commentAuthors/);
    expect(() => parsePolicy("version: 1\nbogus: 1\n")).toThrow();
  });
});

describe("excludePaths in the policy", () => {
  it("parses globs, refuses a bad one, and keeps refusing unknown fields", () => {
    expect(parsePolicy("version: 1\nexcludePaths:\n  - fixtures/**\n").excludePaths).toEqual([
      "fixtures/**",
    ]);
    expect(() => parsePolicy('version: 1\nexcludePaths:\n  - "{broken"\n')).toThrow(
      /excludePaths\.0/,
    );
    expect(() => parsePolicy("version: 1\nexcludePath:\n  - fixtures/**\n")).toThrow(/excludePath/);
  });
});
