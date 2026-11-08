import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../../src/range/diff.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { Git } from "../../src/range/git.js";
import { tempDir } from "../tmp.js";

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: repo,
    encoding: "utf8",
  }).trim();

const BODY = Array.from({ length: 50 }, (_, i) => `line_${i + 1} = ${i + 1}`).join("\n") + "\n";

/** A repository whose second commit renames SYNTHETIC_old.py and changes one line. */
function renamedRepo(): { repo: string; base: string; tip: string } {
  const repo = tempDir("aio-git-");
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "SYNTHETIC_old.py"), BODY);
  writeFileSync(join(repo, "other.py"), "x = 1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "mv", "SYNTHETIC_old.py", "SYNTHETIC_new.py");
  writeFileSync(join(repo, "SYNTHETIC_new.py"), BODY.replace("line_7 = 7", "line_7 = 70"));
  writeFileSync(join(repo, "other.py"), "x = 2\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "rename");
  return { repo, base, tip: git(repo, "rev-parse", "HEAD") };
}

describe("non-ASCII paths", () => {
  it("parse to the real path, which then gives the file's diff and content", async () => {
    const repo = tempDir("aio-git-");
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "café.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "café.txt"), "b\n");
    git(repo, "commit", "-q", "-am", "change");
    const tip = git(repo, "rev-parse", "HEAD");
    const g = new Git(new ExecaRunner(), repo);
    const files = parseDiff(await g.diff(base, tip));
    expect(files.map((f) => f.path)).toEqual(["café.txt"]);
    expect(await g.diffForPrompt(base, tip, ["café.txt"])).toContain("+b");
    expect(await g.show(tip, "café.txt")).toBe("b\n");
  });
});

describe("Git.diffForPrompt", () => {
  it("shows a renamed file as a rename when the pathspec names only its new path", async () => {
    const { repo, base, tip } = renamedRepo();
    const diff = await new Git(new ExecaRunner(), repo).diffForPrompt(base, tip, [
      "SYNTHETIC_new.py",
    ]);
    expect(diff).toContain("rename from SYNTHETIC_old.py");
    expect(diff).toContain("rename to SYNTHETIC_new.py");
    expect(diff).not.toContain("new file mode");
    expect(diff).toContain("+line_7 = 70");
    expect(diff.split("\n").filter((l) => /^\+line_/.test(l))).toHaveLength(1);
    expect(diff).not.toContain("other.py");
  });

  it("takes the paths literally, not as globs or pathspec magic", async () => {
    const repo = tempDir("aio-git-");
    git(repo, "init", "-q", "-b", "main");
    for (const name of ["SYNTHETIC_*.txt", "SYNTHETIC_x.txt", ":(glob)y"]) {
      writeFileSync(join(repo, name), "a\n");
    }
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    for (const name of ["SYNTHETIC_*.txt", "SYNTHETIC_x.txt", ":(glob)y"]) {
      writeFileSync(join(repo, name), "b\n");
    }
    git(repo, "commit", "-q", "-am", "change");
    const g = new Git(new ExecaRunner(), repo);
    const star = await g.diffForPrompt(base, "HEAD", ["SYNTHETIC_*.txt"]);
    expect(star).toContain("b/SYNTHETIC_*.txt");
    expect(star).not.toContain("SYNTHETIC_x.txt");
    expect(await g.diffForPrompt(base, "HEAD", [":(glob)y"])).toContain("b/:(glob)y");
  });

  it("shows a renamed file in the working tree as a rename", async () => {
    const { repo, base } = renamedRepo();
    const diff = await new Git(new ExecaRunner(), repo).diffForPrompt(base, null, [
      "SYNTHETIC_new.py",
    ]);
    expect(diff).toContain("rename from SYNTHETIC_old.py");
    expect(diff).not.toContain("new file mode");
  });
});

describe("excludeEngineDir", () => {
  it("adds .aio/ to the shared info/exclude once, from any worktree", async () => {
    const repo = tempDir("aio-git-");
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "app.py"), "x = 1\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "a");
    const exclude = join(repo, ".git", "info", "exclude");
    // A last line without a newline stays intact.
    writeFileSync(exclude, "*.log");
    const linked = join(tempDir("aio-git-wt-"), "wt");
    git(repo, "worktree", "add", "-q", linked);

    expect(await new Git(new ExecaRunner(), linked).excludeEngineDir()).toBe(true);
    expect(await new Git(new ExecaRunner(), repo).excludeEngineDir()).toBe(false);
    expect(readFileSync(exclude, "utf8")).toBe("*.log\n.aio/\n");

    mkdirSync(join(linked, ".aio", "runs"), { recursive: true });
    writeFileSync(join(linked, ".aio", "runs", "state.json"), "{}");
    expect(git(linked, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});

describe("Git.pathExists", () => {
  function nestedRepo(): { repo: string; rev: string } {
    const repo = tempDir("aio-git-");
    git(repo, "init", "-q", "-b", "main");
    mkdirSync(join(repo, "pkg", "sub"), { recursive: true });
    mkdirSync(join(repo, "other"), { recursive: true });
    writeFileSync(join(repo, "pkg", "sub", "a.ts"), "export const alpha = 1;\n");
    writeFileSync(
      join(repo, "other", "b.ts"),
      "  const SYNTHETIC_moved = compute(); // trailing words\n",
    );
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    return { repo, rev: git(repo, "rev-parse", "HEAD") };
  }

  it("finds a path written with ./ or repeated slashes", async () => {
    const { repo, rev } = nestedRepo();
    const g = new Git(new ExecaRunner(), repo);
    expect(await g.pathExists(rev, "./pkg/sub/a.ts")).toBe(true);
    expect(await g.pathExists(rev, "pkg//sub/a.ts")).toBe(true);
    expect(await g.pathExists(rev, "pkg/sub/missing.ts")).toBe(false);
  });
});

describe("Git.linesFromBase", () => {
  const OLD = "  total = SYNTHETIC_price * quantity\n";

  function baseRepo(): { repo: string; base: string } {
    const repo = tempDir("aio-git-");
    git(repo, "init", "-q", "-b", "main");
    mkdirSync(join(repo, "pkg"), { recursive: true });
    writeFileSync(join(repo, "pkg", "cart.py"), `def old_total(quantity):\n${OLD}  return total\n`);
    writeFileSync(join(repo, "pkg", "util.py"), "def helper():\n  return None\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    return { repo, base: git(repo, "rev-parse", "HEAD") };
  }

  it("traces a renamed function in a moved file to the base, from a subfolder", async () => {
    const { repo, base } = baseRepo();
    git(repo, "mv", "pkg/cart.py", "pkg/basket.py");
    writeFileSync(
      join(repo, "pkg", "basket.py"),
      `def new_total(quantity):\n${OLD}  return total\n`,
    );
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "rename");
    const tip = git(repo, "rev-parse", "HEAD");
    const g = new Git(new ExecaRunner(), join(repo, "pkg"));
    expect(await g.linesFromBase(base, tip, "pkg/basket.py", 1, 3)).toEqual({
      counted: 3,
      fromBase: 2,
    });
  });

  it("doesn't count new generic lines as old because they occur elsewhere", async () => {
    const { repo, base } = baseRepo();
    writeFileSync(join(repo, "pkg", "fresh.py"), "def fresh():\n  return None\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "fresh");
    const tip = git(repo, "rev-parse", "HEAD");
    const g = new Git(new ExecaRunner(), repo);
    expect(await g.linesFromBase(base, tip, "pkg/fresh.py", 1, 2)).toEqual({
      counted: 2,
      fromBase: 0,
    });
  });

  it("returns null when Git fails", async () => {
    const { repo, base } = baseRepo();
    const g = new Git(new ExecaRunner(), repo);
    expect(await g.linesFromBase(base, base, "pkg/missing.py", 1, 2)).toBeNull();
  });
});
