import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addWorktree,
  branchFor,
  checkRemovable,
  commonExcludeFile,
  currentBranch,
  ensureExcluded,
  ensureNotesDir,
  ensureWorktreeNotesDir,
  git,
  infraFile,
  isBuildOutputName,
  isRepo,
  mergeExcludeRules,
  notesDir,
  originUrl,
  removeWorktree,
  topLevel,
  worktreeNotesDir,
  worktreePath,
} from "../../src/worktrees/index.js";
import { commitAll, initRepo, sh, tempDir, write } from "./helpers.js";

describe("paths", () => {
  it("builds the worktree, branch, and notes paths", () => {
    expect(worktreePath("/r/repo/", "fix")).toBe("/r/repo/.worktrees/fix");
    expect(branchFor("fix")).toBe("claude/fix");
    expect(notesDir("/p", "fix")).toBe("/p/.aio/conversations/fix");
    expect(infraFile("/p/")).toBe("/p/.aio/INFRA.md");
    expect(worktreeNotesDir("/r/.worktrees/fix")).toBe("/r/.worktrees/fix/.aio");
  });

  it("creates the notes directories", () => {
    const root = tempDir();
    expect(fs.statSync(ensureNotesDir(root, "a")).isDirectory()).toBe(true);
    expect(fs.statSync(ensureWorktreeNotesDir(path.join(root, "wt"))).isDirectory()).toBe(true);
  });

  it("knows build output names", () => {
    for (const n of [
      "node_modules",
      "build",
      "dist",
      "target",
      ".gradle",
      "__pycache__",
      ".venv",
      "venv",
      ".cache",
      ".next",
      "out",
    ]) {
      expect(isBuildOutputName(n)).toBe(true);
    }
    expect(isBuildOutputName(".env")).toBe(false);
  });
});

describe("git queries", () => {
  it("reads repository facts", async () => {
    const root = tempDir();
    const repo = initRepo(path.join(root, "repo"), "git@example.com:org/repo.git");
    expect(await isRepo(repo)).toBe(true);
    expect(await isRepo(root)).toBe(false);
    expect(await isRepo(path.join(root, "missing"))).toBe(false);
    expect(await topLevel(repo)).toBe(repo);
    expect(await currentBranch(repo)).toBe("main");
    expect(await originUrl(repo)).toBe("git@example.com:org/repo.git");
    sh(repo, "checkout", "-q", "--detach");
    expect(await currentBranch(repo)).toBe("");
    const r = await git(repo, ["no-such-command"]);
    expect(r.ok).toBe(false);
  });
});

describe("exclude rules", () => {
  it("adds the two entries once and handles a missing trailing newline", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const file = await commonExcludeFile(repo);
    fs.writeFileSync(file, "*.log");
    expect((await ensureExcluded(repo)).ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("*.log\n# aio\n.worktrees/\n.aio/\n");
    expect((await ensureExcluded(repo)).ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("*.log\n# aio\n.worktrees/\n.aio/\n");
  });

  it("accepts entries that are already there with a leading slash or trailing spaces", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const file = await commonExcludeFile(repo);
    fs.writeFileSync(file, "/.worktrees/\n.aio/  \n");
    await ensureExcluded(repo);
    expect(fs.readFileSync(file, "utf8")).toBe("/.worktrees/\n.aio/  \n");
  });

  it("merges a clone's exclude rules without duplicates or comments", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const file = await commonExcludeFile(repo);
    fs.writeFileSync(file, "*.log\n");
    const from = path.join(tempDir(), "exclude");
    fs.writeFileSync(from, "# comment\n*.log\n\n.env.local\nsecrets/\n.env.local\n");
    expect(await mergeExcludeRules(repo, from)).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe("*.log\n.env.local\nsecrets/\n");
    expect(await mergeExcludeRules(repo, from)).toBe(0);
    expect(await mergeExcludeRules(repo, path.join(tempDir(), "none"))).toBe(0);
  });
});

describe("addWorktree", () => {
  it("adds, reuses, and refuses a path that is not a worktree", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const added = await addWorktree(repo, "fix");
    expect(added).toEqual({ ok: true, path: `${repo}/.worktrees/fix` });
    expect(await currentBranch(`${repo}/.worktrees/fix`)).toBe("claude/fix");
    expect(fs.readFileSync(await commonExcludeFile(repo), "utf8")).toContain(".worktrees/");
    expect(await addWorktree(repo, "fix")).toEqual(added);

    fs.mkdirSync(`${repo}/.worktrees/plain`, { recursive: true });
    const refused = await addWorktree(repo, "plain");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("exists but is not a git worktree");
  });

  it("checks out an existing branch", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    sh(repo, "branch", "claude/old");
    const added = await addWorktree(repo, "old");
    expect(added.ok).toBe(true);
    expect(await currentBranch(`${repo}/.worktrees/old`)).toBe("claude/old");
  });
});

describe("checkRemovable and removeWorktree", () => {
  async function fresh() {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const added = await addWorktree(repo, "fix");
    if (!added.ok) throw new Error(added.error);
    return { repo, wt: added.path };
  }

  it("is safe for a clean worktree", async () => {
    const { repo, wt } = await fresh();
    expect(await checkRemovable(repo, wt)).toEqual({ safe: true });
  });

  it("refuses a path that is not a worktree", async () => {
    const { repo } = await fresh();
    expect(await checkRemovable(repo, path.join(repo, "nope"))).toEqual({
      safe: false,
      reason: "not a worktree",
    });
  });

  it("refuses uncommitted and untracked changes", async () => {
    const { repo, wt } = await fresh();
    write(`${wt}/README.md`, "changed\n");
    expect(await checkRemovable(repo, wt)).toEqual({
      safe: false,
      reason: "it has uncommitted or untracked changes",
    });
    sh(wt, "checkout", "--", "README.md");
    write(`${wt}/new.txt`, "x");
    expect((await checkRemovable(repo, wt)).safe).toBe(false);
  });

  it("refuses an ignored .env but allows build output and the notes folder", async () => {
    const { repo, wt } = await fresh();
    write(`${wt}/.gitignore`, ".env\nnode_modules/\n");
    commitAll(wt, "Ignore things");
    sh(repo, "branch", "keep", "claude/fix"); // the commit exists elsewhere
    write(`${wt}/node_modules/a/index.js`, "x");
    write(`${wt}/.aio/PLAN.md`, "plan");
    expect(await checkRemovable(repo, wt)).toEqual({ safe: true });
    write(`${wt}/.env`, "SECRET=1");
    const c = await checkRemovable(repo, wt);
    expect(c).toEqual({
      safe: false,
      reason: "it has ignored files that exist nowhere else (.env)",
    });
  });

  it("refuses a nested notes folder and a secret inside build output", async () => {
    const { repo, wt } = await fresh();
    write(`${wt}/.gitignore`, "out/\nnode_modules/\n.aio/\n");
    write(`${wt}/sub/tracked.txt`, "x");
    commitAll(wt, "Ignore things");
    sh(repo, "branch", "keep", "claude/fix");
    write(`${wt}/sub/.aio/PLAN.md`, "nested plan");
    expect(await checkRemovable(repo, wt)).toEqual({
      safe: false,
      reason: "it has ignored files that exist nowhere else (sub/.aio/)",
    });
    fs.rmSync(`${wt}/sub/.aio`, { recursive: true });
    write(`${wt}/out/bundle.js`, "x");
    write(`${wt}/node_modules/lib/test/fixture.pem`, "not mine");
    expect(await checkRemovable(repo, wt)).toEqual({ safe: true });
    write(`${wt}/out/.env`, "SECRET=1");
    expect(await checkRemovable(repo, wt)).toEqual({
      safe: false,
      reason: "it has ignored files that exist nowhere else (out/.env)",
    });
  });

  it("refuses a branch with commits found nowhere else", async () => {
    const { repo, wt } = await fresh();
    write(`${wt}/a.txt`, "a");
    commitAll(wt, "Work");
    expect(await checkRemovable(repo, wt)).toEqual({
      safe: false,
      reason: "branch claude/fix has 1 commit(s) that are not on any other branch",
    });
    sh(repo, "branch", "backup", "claude/fix");
    expect(await checkRemovable(repo, wt)).toEqual({ safe: true });
  });

  it("refuses a detached HEAD with a unique commit", async () => {
    const { repo, wt } = await fresh();
    sh(wt, "checkout", "-q", "--detach");
    write(`${wt}/a.txt`, "a");
    commitAll(wt, "Detached work");
    expect(await checkRemovable(repo, wt)).toEqual({
      safe: false,
      reason: "HEAD is detached and has 1 commit(s) that are not on any branch",
    });
  });

  it("archives notes, removes the worktree, and deletes the claude/ branch", async () => {
    const { repo, wt } = await fresh();
    write(`${wt}/.aio/STATUS.md`, "status");
    const r = await removeWorktree(repo, wt, new Date(2026, 9, 28, 9, 30, 15));
    expect(r).toEqual({ ok: true, archive: `${repo}/.aio/archive/fix-20261028093015` });
    expect(fs.readFileSync(`${repo}/.aio/archive/fix-20261028093015/STATUS.md`, "utf8")).toBe(
      "status",
    );
    expect(fs.existsSync(wt)).toBe(false);
    expect(sh(repo, "branch", "--list", "claude/fix")).toBe("");
  });

  it("puts the notes back when git refuses the removal", async () => {
    const { repo, wt } = await fresh();
    write(`${wt}/.aio/STATUS.md`, "status");
    sh(repo, "worktree", "lock", wt);
    const r = await removeWorktree(repo, wt, new Date(2026, 9, 28, 9, 30, 15));
    expect(r.ok).toBe(false);
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.readFileSync(`${wt}/.aio/STATUS.md`, "utf8")).toBe("status");
    expect(fs.existsSync(`${repo}/.aio/archive/fix-20261028093015`)).toBe(false);
  });

  it("keeps a branch outside claude/ and refuses an unsafe worktree", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    sh(repo, "worktree", "add", "-q", "-b", "other", `${repo}/.worktrees/other`);
    expect(await removeWorktree(repo, `${repo}/.worktrees/other`)).toEqual({ ok: true });
    expect(sh(repo, "branch", "--list", "other")).toContain("other");

    const added = await addWorktree(repo, "dirty");
    if (!added.ok) throw new Error(added.error);
    write(`${added.path}/x.txt`, "x");
    const r = await removeWorktree(repo, added.path);
    expect(r).toEqual({ ok: false, reason: "it has uncommitted or untracked changes" });
    expect(fs.existsSync(added.path)).toBe(true);
  });
});

describe("host git safety", () => {
  it("runs no hook, fsmonitor, or filter driver that a box wrote into the repository", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const marker = path.join(tempDir("aio-marker-"), "SYNTHETIC_PWNED");
    const script = path.join(repo, ".git", "SYNTHETIC_payload.sh");
    write(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`);
    fs.chmodSync(script, 0o755);
    for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
      write(path.join(repo, ".git", "hooks", hook), `#!/bin/sh\n'${script}' ${hook} </dev/null\n`);
      fs.chmodSync(path.join(repo, ".git", "hooks", hook), 0o755);
    }
    sh(repo, "config", "core.fsmonitor", script);
    sh(repo, "config", "filter.x.smudge", script);
    sh(repo, "config", "filter.x.clean", script);
    sh(repo, "config", "filter.x.required", "true");
    write(path.join(repo, ".gitattributes"), "*.txt filter=x\n");
    write(path.join(repo, "a.txt"), "SYNTHETIC content\n");
    // Commit without the payload: the test helper's git honors the config.
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "filter.x.clean=",
      "-c",
      "filter.x.required=false",
      "-c",
      "core.fsmonitor=false",
      "add",
      "-A",
    ]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "commit",
      "-q",
      "-m",
      "attrs",
    ]);
    fs.rmSync(marker, { force: true });

    const added = await addWorktree(repo, "safety");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(fs.readFileSync(path.join(added.path, "a.txt"), "utf8")).toBe("SYNTHETIC content\n");
    write(path.join(added.path, "a.txt"), "changed\n");
    await git(added.path, ["status", "--porcelain"]);
    await checkRemovable(repo, added.path);
    expect(fs.existsSync(marker)).toBe(false);

    // The same repository does run the payload under plain git.
    sh(repo, "status", "--porcelain");
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("keeps a filter driver set only in the user's global configuration", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const globalFile = path.join(tempDir("aio-global-"), "gitconfig");
    write(globalFile, '[filter "up"]\n\tsmudge = tr a-z A-Z\n\tclean = cat\n');
    write(path.join(repo, ".gitattributes"), "*.txt filter=up\n");
    write(path.join(repo, "b.txt"), "SYNTHETIC lower\n");
    commitAll(repo, "attrs");
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalFile;
    try {
      const added = await addWorktree(repo, "lfs-like");
      expect(added.ok).toBe(true);
      if (added.ok) {
        expect(fs.readFileSync(path.join(added.path, "b.txt"), "utf8")).toBe("SYNTHETIC LOWER\n");
      }
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });

  it("refuses transports other than local paths", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const marker = path.join(tempDir("aio-marker-"), "SYNTHETIC_PWNED");
    const script = path.join(repo, ".git", "SYNTHETIC_ssh.sh");
    write(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    fs.chmodSync(script, 0o755);
    sh(repo, "config", "core.sshCommand", script);
    sh(repo, "config", "url.ssh://git@example.com/x.insteadOf", "SYNTHETIC:");
    const r = await git(repo, ["fetch", "SYNTHETIC:x", "main"]);
    expect(r.ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    // A local path still fetches.
    const other = initRepo(path.join(tempDir(), "other"));
    expect((await git(repo, ["fetch", other, "main:refs/heads/SYNTHETIC_other"])).ok).toBe(true);
  });
});
