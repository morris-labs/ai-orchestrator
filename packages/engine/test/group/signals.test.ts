// The tier signals against a real repository.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_POLICY, type FileGroup, type PolicyFile } from "@aio/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { assignTiers, splitFunctionDiff } from "../../src/group/signals.js";
import { parseDiff } from "../../src/range/diff.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { Git } from "../../src/range/git.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(before: Record<string, string>, after: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "tier-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  const put = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "c");
    return git("rev-parse", "HEAD");
  };
  return { dir, base: put(before), tip: put(after) };
}

async function tier(
  before: Record<string, string>,
  after: Record<string, string>,
  policy: PolicyFile = DEFAULT_POLICY,
  budgetMs?: number,
) {
  const { dir, base, tip } = repo(before, after);
  const git = new Git(new ExecaRunner(), dir);
  const files = parseDiff(await git.diff(base, tip));
  const group: FileGroup = {
    id: "G01",
    files: files.map((f) => f.path),
    kind: "minor",
    changedLines: 0,
    riskPath: false,
    hunks: [],
  };
  const [out] = await assignTiers([group], files, {
    git,
    policy,
    diffBase: base,
    tip,
    choice: "auto",
    ...(budgetMs !== undefined ? { budgetMs } : {}),
  });
  return out as FileGroup;
}

const body = (name: string, n: number) => `function ${name}() {\n  return ${n};\n}\n`;
const callers = (n: number, name = "chargeCard") =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`src/use${i}.ts`, `${name}();\n`] as const),
  );

describe("assignTiers", () => {
  it("gives docs the small tier", async () => {
    const g = await tier({ "a.md": "one\n" }, { "a.md": "two\n" });
    expect(g.tier).toBe("small");
  });

  it("gives a comment-only change the small tier", async () => {
    const g = await tier({ "a.ts": "// one\nf();\n" }, { "a.ts": "// two\nf();\n" });
    expect(g.tier).toBe("small");
  });

  it("gives 30-line and 300-line code files with 3 changed lines the medium tier", async () => {
    const lines = (n: number, end: string) =>
      Array.from({ length: n }, (_, i) => `a${i}();`).join("\n") + `\n${end}\n`;
    const short = await tier({ "a.ts": lines(29, "x();") }, { "a.ts": lines(29, "y();") });
    const long = await tier({ "a.ts": lines(299, "x();") }, { "a.ts": lines(299, "y();") });
    expect(short.tier).toBe("medium");
    expect(long.tier).toBe("medium");
    expect(long.tierReason).toMatch(/300 lines/);
  });

  it("counts references, without the file, its tests, or docs", async () => {
    const before = {
      "src/pay.ts": body("chargeCard", 1),
      "src/pay.test.ts": "chargeCard();\n",
      "docs/pay.md": "chargeCard\n",
      ...callers(3),
    };
    const g = await tier(before, { ...before, "src/pay.ts": body("chargeCard", 2) });
    expect(g.tier).toBe("medium");
    expect(g.tierReason).toMatch(/chargeCard appears in 3 other files/);
  });

  it("moves to large at 10 references", async () => {
    const before = { "src/pay.ts": body("chargeCard", 1), ...callers(10) };
    const g = await tier(before, { ...before, "src/pay.ts": body("chargeCard", 2) });
    expect(g.tier).toBe("large");
  });

  it("falls back to the other signals at the time limit", async () => {
    const before = { "src/pay.ts": body("chargeCard", 1), ...callers(10) };
    const g = await tier(before, { ...before, "src/pay.ts": body("chargeCard", 2) }, undefined, 0);
    expect(g.tier).toBe("medium");
    expect(g.tierReason).toMatch(/ran out of time/);
  });

  it("honors risk paths and policy tiers", async () => {
    const risk = await tier(
      { "a.md": "1\n" },
      { "a.md": "2\n" },
      {
        ...DEFAULT_POLICY,
        riskPaths: ["a.md"],
      },
    );
    expect(risk.tier).toBe("large");
    const pinned = await tier(
      { "gen/a.ts": "a();\n" },
      { "gen/a.ts": "b();\n" },
      {
        ...DEFAULT_POLICY,
        tierPaths: [{ paths: ["gen/**"], tier: "small" }],
      },
    );
    expect(pinned.tier).toBe("medium");
  });
});

describe("code floor", () => {
  it("keeps code at medium under a small tierPaths rule, and a JSX // change counts as code", async () => {
    const policy = { ...DEFAULT_POLICY, tierPaths: [{ paths: ["**"], tier: "small" as const }] };
    const code = await tier({ "gen/a.ts": "a();\n" }, { "gen/a.ts": "b();\n" }, policy);
    expect(code.tier).toBe("medium");
    const jsx = await tier(
      { "a.tsx": "<a>// one</a>;\n" },
      { "a.tsx": "<a>// two</a>;\n" },
      policy,
    );
    expect(jsx.tier).toBe("medium");
    const docs = await tier({ "a.md": "1\n" }, { "a.md": "2\n" }, policy);
    expect(docs.tier).toBe("small");
  });

  it("measures code under a fixed small tier", async () => {
    const { dir, base, tip } = repo(
      { "a.ts": "a();\n", "b.md": "1\n" },
      { "a.ts": "b();\n", "b.md": "2\n" },
    );
    const git = new Git(new ExecaRunner(), dir);
    const files = parseDiff(await git.diff(base, tip));
    const group = (id: string, paths: string[]): FileGroup => ({
      id,
      files: paths,
      kind: "minor",
      changedLines: 1,
      riskPath: false,
      hunks: [],
    });
    const [code, docs] = await assignTiers(
      [group("G01", ["a.ts"]), group("G02", ["b.md"])],
      files,
      {
        git,
        policy: DEFAULT_POLICY,
        diffBase: base,
        tip,
        choice: "small",
      },
    );
    expect(code?.tier).toBe("medium");
    expect(docs?.tier).toBe("small");
  });
});

describe("Git.grepFiles", () => {
  it("treats a word that looks like an option as text", async () => {
    const { dir, tip } = repo({ "a.txt": "--output\n" }, { "a.txt": "--output x\n" });
    const git = new Git(new ExecaRunner(), dir);
    expect(await git.grepFiles("--output", tip, 5000)).toEqual(["a.txt"]);
    expect(await git.grepFiles("absentword", tip, 5000)).toEqual([]);
  });
});

describe("splitFunctionDiff", () => {
  it("keeps each file's hunks", () => {
    const text =
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n" +
      "diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-c\n+d\n";
    const out = splitFunctionDiff(text);
    expect(out.get("x.ts")?.slice(0, 3)).toEqual(["@@ -1 +1 @@", "-a", "+b"]);
    expect(out.get("y.ts")?.[2]).toBe("+d");
  });
});
