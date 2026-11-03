// The tier signals against a real repository.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_POLICY, type FileGroup, type PolicyFile } from "@aio/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assignTiers, splitFunctionDiff } from "../../src/group/signals.js";
import { parseDiff } from "../../src/range/diff.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { Git } from "../../src/range/git.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

type Tree = Record<string, string | null>;

function repo(before: Tree, after: Tree) {
  const dir = mkdtempSync(join(tmpdir(), "tier-"));
  dirs.push(dir);
  // Nothing from the host's git setup or a calling git hook reaches this repository.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const name of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete env[name];
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  git("init", "-q", "--template=");
  const put = (files: Tree) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        rmSync(join(dir, path));
        continue;
      }
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
  before: Tree,
  after: Tree,
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

  it("treats a comment or formatting change in code as code", async () => {
    const comment = await tier({ "a.ts": "// one\nf();\n" }, { "a.ts": "// two\nf();\n" });
    expect(comment.tier).toBe("medium");
    const spacing = await tier({ "a.py": "f()\n" }, { "a.py": "f()\n\n" });
    expect(spacing.tier).toBe("medium");
  });

  it("keeps the small tier for a lockfile but not for agent instructions", async () => {
    const lock = await tier({ "pnpm-lock.yaml": "a\n" }, { "pnpm-lock.yaml": "b\n" });
    expect(lock.tier).toBe("small");
    const agent = await tier({ "CLAUDE.md": "a\n" }, { "CLAUDE.md": "b\n" });
    expect(agent.tier).toBe("medium");
  });

  it("raises a lockfile that adds a dependency source on a new host", async () => {
    const before = { "pnpm-lock.yaml": "a:\n  resolved: https://registry.npmjs.org/a-1.tgz\n" };
    const bump = await tier(before, {
      "pnpm-lock.yaml": "a:\n  resolved: https://registry.npmjs.org/a-2.tgz\n",
    });
    expect(bump.tier).toBe("small");
    const moved = await tier(before, {
      "pnpm-lock.yaml": "a:\n  resolved: https://example.com/a-2.tgz\n",
    });
    expect(moved.tier).toBe("medium");
    expect(moved.tierReason).toMatch(/source/);
  });

  it("treats a rename from code to a doc name as code", async () => {
    const renamed = await tier(
      { "deploy.py": "run()\nrun()\nrun()\n" },
      { "deploy.py": null, "deploy.md": "run()\nrun()\nrun()\n" },
    );
    expect(renamed.tier).toBe("medium");
  });

  it("notes a failed function diff in the reason", async () => {
    const { dir, base, tip } = repo({ "a.ts": "a();\n" }, { "a.ts": "b();\n" });
    const git = new Git(new ExecaRunner(), dir);
    const files = parseDiff(await git.diff(base, tip));
    vi.spyOn(git, "functionDiff").mockRejectedValue(new Error("no"));
    const [out] = await assignTiers(
      [{ id: "G01", files: ["a.ts"], kind: "minor", changedLines: 1, riskPath: false, hunks: [] }],
      files,
      { git, policy: DEFAULT_POLICY, diffBase: base, tip, choice: "auto" },
    );
    expect(out?.tierReason).toMatch(/function diff failed/);
  });

  it("counts references, without the file, its tests, docs, or generated data", async () => {
    const before = {
      "src/pay.ts": body("chargeCard", 1),
      "src/pay.test.ts": "chargeCard();\n",
      "docs/pay.md": "chargeCard\n",
      "pnpm-lock.yaml": "chargeCard\n",
      "dist/a.js": "chargeCard\n",
      "data/a.json": "chargeCard\n",
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

describe("renames", () => {
  const text = "first();\nsecond();\nthird();\nfourth();\nfifth();\nsixth();\n";
  const moved = (from: string, to: string) =>
    [{ [from]: text }, { [from]: null, [to]: `${text}seventh();\n` }] as const;

  it("keeps the large tier of an old risk path", async () => {
    const policy = { ...DEFAULT_POLICY, riskPaths: ["src/auth/**"] };
    const g = await tier(...moved("src/auth/tokens.ts", "src/misc/tokens.ts"), policy);
    expect(g.tier).toBe("large");
    expect(g.tierReason).toMatch(/renamed from src\/auth\/tokens\.ts.*risk path/);
  });

  it("keeps the large tier of an old schema path", async () => {
    const g = await tier(...moved("schemas/user.ts", "src/user.ts"));
    expect(g.tier).toBe("large");
    expect(g.tierReason).toMatch(/renamed from schemas\/user\.ts/);
  });

  it("keeps the large tier of an old tierPaths rule", async () => {
    const policy = {
      ...DEFAULT_POLICY,
      tierPaths: [{ paths: ["core/**"], tier: "large" as const }],
    };
    const g = await tier(...moved("core/a.ts", "src/a.ts"), policy);
    expect(g.tier).toBe("large");
  });

  it("keeps an old risk path's tier under a small rule on the current path", async () => {
    const policy = {
      ...DEFAULT_POLICY,
      riskPaths: ["src/auth/**"],
      tierPaths: [{ paths: ["gen/**"], tier: "small" as const }],
    };
    const g = await tier(...moved("src/auth/a.ts", "gen/a.ts"), policy);
    expect(g.tier).toBe("large");
  });

  it("doesn't let an old small rule lower the current path's tier", async () => {
    const policy = {
      ...DEFAULT_POLICY,
      riskPaths: ["src/auth/**"],
      tierPaths: [{ paths: ["gen/**"], tier: "small" as const }],
    };
    const g = await tier(...moved("gen/a.ts", "src/auth/a.ts"), policy);
    expect(g.tier).toBe("large");
  });

  it("leaves other renames at medium", async () => {
    const g = await tier(...moved("src/a.ts", "src/b.ts"));
    expect(g.tier).toBe("medium");
  });
});

describe("code floor", () => {
  it("keeps code at medium under a small tierPaths rule", async () => {
    const policy = { ...DEFAULT_POLICY, tierPaths: [{ paths: ["**"], tier: "small" as const }] };
    const code = await tier({ "gen/a.ts": "a();\n" }, { "gen/a.ts": "b();\n" }, policy);
    expect(code.tier).toBe("medium");
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
    expect(await git.grepFiles("anyword", "0".repeat(40), 5000)).toBe("error");
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

  it.each(["\r", "\u2028", "\u2029"])("keeps a file boundary out of content after %j", (sep) => {
    const forged = `+x${sep}diff --git a/x.ts b/x.ts`;
    const text =
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n" +
      `diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-c\n${forged}\n+d\n`;
    const out = splitFunctionDiff(text);
    expect(out.get("x.ts")?.slice(0, 3)).toEqual(["@@ -1 +1 @@", "-a", "+b"]);
    expect(out.get("y.ts")?.slice(0, 4)).toEqual(["@@ -1 +1 @@", "-c", forged, "+d"]);
  });
});
