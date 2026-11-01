import fs from "node:fs";
import path from "node:path";
import type { Box } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { projectDirFor } from "../../src/catalog/paths.js";
import { ApiError } from "../../src/records/errors.js";
import {
  executeMigration,
  normalizeUrl,
  parseStatus,
  planMigration,
  planReport,
} from "../../src/worktrees/index.js";
import {
  cloneInto,
  commitAll,
  makeBox,
  originAndProject,
  sh,
  tempDir,
  testEnv,
  write,
} from "./helpers.js";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("normalizeUrl and parseStatus", () => {
  it("treats ssh and https spellings of one repository as equal", () => {
    expect(normalizeUrl("git@github.com:Org/Repo.git")).toBe("github.com/org/repo");
    expect(normalizeUrl("https://github.com/org/repo/")).toBe("github.com/org/repo");
    expect(normalizeUrl("ssh://git@example.com/x/y.git")).toBe("example.com/x/y");
    expect(normalizeUrl("/srv/origin.git")).toBe("/srv/origin");
    expect(normalizeUrl("")).toBe("");
  });

  it("parses porcelain entries and keeps rename sources as from", () => {
    const raw = " M a.txt\0R  new.txt\0old.txt\0?? b.txt\0 D c.txt\0";
    expect(parseStatus(raw)).toEqual([
      { xy: " M", path: "a.txt" },
      { xy: "R ", path: "new.txt", from: "old.txt" },
      { xy: "??", path: "b.txt" },
      { xy: " D", path: "c.txt" },
    ]);
  });
});

/** A project repository, its home, and a workspace clone with a lot of state. */
function scenario() {
  const root = tempDir("aio-mig-");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = testEnv(home);
  const { origin, project } = originAndProject(root);
  const clone = cloneInto(origin, path.join(project, "fix_login"));

  // Committed setup on the clone's working branch, not pushed.
  sh(clone, "checkout", "-q", "-b", "feature");
  write(`${clone}/.gitignore`, ".env\nnode_modules/\n");
  write(`${clone}/del.txt`, "delete me\n");
  commitAll(clone, "Feature setup");

  // Another branch and a tag found nowhere else.
  sh(clone, "checkout", "-q", "-b", "side");
  write(`${clone}/side.txt`, "side\n");
  commitAll(clone, "Side work");
  sh(clone, "tag", "v-local");
  sh(clone, "checkout", "-q", "feature");

  // A stash.
  write(`${clone}/README.md`, "stashed\n");
  sh(clone, "stash", "-q");

  // Working-tree state.
  write(`${clone}/README.md`, "changed\n");
  write(`${clone}/src/new.ts`, "export {};\n");
  fs.rmSync(`${clone}/del.txt`);
  write(`${clone}/.env`, "SECRET=1\n");
  write(`${clone}/node_modules/pkg/index.js`, "module.exports = 1;\n");
  write(`${clone}/PLAN.md`, "the plan\n");

  // What cannot be carried, and local ignore rules.
  write(`${clone}/.git/hooks/pre-commit`, "#!/bin/sh\n");
  sh(clone, "config", "custom.key", "value");
  fs.appendFileSync(`${clone}/.git/info/exclude`, "local-only/\n");

  // Transcripts: the box's own under the project root, another under the folder.
  write(path.join(projectDirFor(env, project), `${UUID}.jsonl`), '{"type":"user"}\n');
  write(path.join(projectDirFor(env, clone), "other.jsonl"), '{"type":"user"}\n{"x":1}\n');

  const box = makeBox({ targetDir: project, workspace: "fix_login", sessionUuid: UUID });
  return { root, env, origin, project, clone, box };
}

describe("planMigration", () => {
  it("plans a complete conversion", async () => {
    const { env, project, clone, box } = scenario();
    const plan = await planMigration({ env, box, primaryRepo: project });
    expect(plan.problem).toBe("");
    expect(plan.ok).toBe(true);
    expect(plan.oldDir).toBe(clone);
    expect(plan.worktree).toBe(`${project}/.worktrees/fix_login`);
    expect(plan.branch).toBe("claude/fix_login");
    expect(plan.cloneBranch).toBe("feature");
    expect(plan.keepPrefix).toBe("claude-keep/fix_login/");
    expect(plan.keepBranches).toEqual(["side"]);
    expect(plan.keepTags).toEqual(["v-local"]);
    expect(plan.keepStashes).toHaveLength(1);
    expect(plan.excludeRules).toBe(1);
    expect(plan.cloneOnly).toEqual(["hook pre-commit", "git setting custom.key"]);
    expect(plan.notesFiles).toEqual(["PLAN.md"]);
    expect(plan.copyFiles.sort()).toEqual([".env", "README.md", "src/new.ts"]);
    expect(plan.removeFiles).toEqual(["del.txt"]);
    expect(plan.skippedIgnored).toEqual(["node_modules/"]);
    expect(plan.skippedBytes).toBeGreaterThan(0);
    expect(plan.transcripts).toEqual([`${UUID}.jsonl`, "other.jsonl"]);
    expect(plan.ownTranscriptFound).toBe(true);
    const report = planReport(plan);
    expect(report[0]).toBe(`Folder:      ${clone} (branch feature)`);
    expect(report.join("\n")).toContain("is NOT copied; rebuild it");
    expect(report.join("\n")).toContain(
      "NOT carried over (set up again if you need them): hook pre-commit",
    );
  });

  it("refuses what it cannot convert", async () => {
    const { env, project, origin, clone, box, root } = scenario();
    const problem = async (b: Box) =>
      (await planMigration({ env, box: b, primaryRepo: project })).problem;

    const noWorkspace: Box = { ...box };
    delete noWorkspace.workspace;
    expect(await problem(noWorkspace)).toBe("this box does not work in a workspace subfolder");
    expect(await problem({ ...box, worktree: "/x" })).toBe("this box already works in a worktree");
    expect((await planMigration({ env, box, primaryRepo: undefined })).problem).toBe(
      "the project has no git repository to make a worktree from",
    );
    expect(await problem({ ...box, workspace: "missing" })).toBe(
      `${project}/missing does not exist`,
    );

    fs.mkdirSync(`${project}/plain`);
    expect(await problem({ ...box, workspace: "plain" })).toBe(
      "the folder is not an independent git clone",
    );

    const otherOrigin = path.join(root, "other.git");
    sh(root, "init", "-q", "--bare", otherOrigin);
    sh(clone, "remote", "set-url", "origin", otherOrigin);
    expect(await problem(box)).toContain("the folder is a clone of a different repository");
    sh(clone, "remote", "set-url", "origin", origin);

    sh(clone, "checkout", "-q", "--detach");
    expect(await problem(box)).toBe("the clone has a detached HEAD; check out a branch first");
    sh(clone, "checkout", "-q", "feature");

    sh(project, "branch", "claude/fix_login");
    expect(await problem(box)).toBe("the branch claude/fix_login already exists in the repository");
    sh(project, "branch", "-D", "claude/fix_login");

    fs.mkdirSync(`${project}/.worktrees/fix_login`, { recursive: true });
    expect(await problem(box)).toBe(`${project}/.worktrees/fix_login already exists`);
  });
});

describe("executeMigration", () => {
  it("converts the folder and keeps everything", async () => {
    const { env, project, clone, box } = scenario();
    const plan = await planMigration({ env, box, primaryRepo: project });
    const saved: Box[] = [];
    const result = await executeMigration({ env, box, plan, saveBox: (b) => void saved.push(b) });

    const wt = `${project}/.worktrees/fix_login`;
    expect(result.worktree).toBe(wt);
    expect(result.branch).toBe("claude/fix_login");
    expect(result.oldFolder).toBe(`${clone}.pre-worktree`);
    expect(result.warning).toBeUndefined();
    expect(result.notCarried).toEqual(["hook pre-commit", "git setting custom.key"]);
    expect(result.keptRefs).toEqual([
      "refs/heads/claude-keep/fix_login/side",
      "refs/tags/v-local",
      "refs/heads/claude-keep/fix_login/stash-0",
    ]);

    // The record.
    expect(saved).toHaveLength(1);
    expect(result.box).toEqual(saved[0]);
    expect(result.box.worktree).toBe(wt);
    expect(result.box.branch).toBe("claude/fix_login");
    expect(result.box.movedFrom).toBe(clone);
    expect(result.box.workspace).toBeUndefined();
    expect(result.recordBackup).toBe(
      path.join(env.home, ".ai-orchestrator/backup", `${box.id}.20261028093015`),
    );
    expect(JSON.parse(fs.readFileSync(result.recordBackup, "utf8"))).toEqual(box);

    // Git state.
    expect(sh(wt, "symbolic-ref", "--short", "HEAD")).toBe("claude/fix_login");
    expect(sh(wt, "log", "-1", "--format=%s")).toBe("Feature setup");
    expect(sh(project, "rev-parse", "claude-keep/fix_login/side")).toBe(
      sh(`${clone}.pre-worktree`, "rev-parse", "side"),
    );
    expect(sh(project, "rev-parse", "v-local")).not.toBe("");
    expect(sh(project, "rev-parse", "claude-keep/fix_login/stash-0")).not.toBe("");
    expect(fs.readFileSync(`${project}/.git/info/exclude`, "utf8")).toContain("local-only/");

    // Files.
    expect(fs.readFileSync(`${wt}/README.md`, "utf8")).toBe("changed\n");
    expect(fs.readFileSync(`${wt}/src/new.ts`, "utf8")).toBe("export {};\n");
    expect(fs.readFileSync(`${wt}/.env`, "utf8")).toBe("SECRET=1\n");
    expect(fs.existsSync(`${wt}/del.txt`)).toBe(false);
    expect(fs.existsSync(`${wt}/node_modules`)).toBe(false);
    expect(fs.readFileSync(`${wt}/.aio/PLAN.md`, "utf8")).toBe("the plan\n");

    // Transcripts are copied, not moved.
    const to = projectDirFor(env, wt);
    expect(fs.readdirSync(to).sort()).toEqual([`${UUID}.jsonl`, "other.jsonl"]);
    expect(fs.existsSync(path.join(projectDirFor(env, project), `${UUID}.jsonl`))).toBe(true);

    // The old folder stepped aside, intact.
    expect(fs.existsSync(clone)).toBe(false);
    expect(fs.readFileSync(`${clone}.pre-worktree/.env`, "utf8")).toBe("SECRET=1\n");
  });

  it("copies build output when asked", async () => {
    const { env, project, box } = scenario();
    const plan = await planMigration({ env, box, primaryRepo: project, includeBuildOutput: true });
    expect(planReport(plan).join("\n")).toContain("will be copied");
    await executeMigration({ env, box, plan, saveBox: () => undefined });
    expect(
      fs.readFileSync(`${project}/.worktrees/fix_login/node_modules/pkg/index.js`, "utf8"),
    ).toBe("module.exports = 1;\n");
  });

  it("rolls back when the record cannot be saved", async () => {
    const { env, project, clone, box } = scenario();
    const plan = await planMigration({ env, box, primaryRepo: project });
    const run = executeMigration({
      env,
      box,
      plan,
      saveBox: () => {
        throw new Error("disk full");
      },
    });
    await expect(run).rejects.toBeInstanceOf(ApiError);
    await expect(run).rejects.toMatchObject({
      code: "conflict",
      message: "could not save the box record: disk full",
    });

    expect(fs.existsSync(`${project}/.worktrees/fix_login`)).toBe(false);
    expect(sh(project, "branch", "--list", "claude/fix_login", "claude-keep/*")).toBe("");
    expect(sh(project, "tag", "--list", "v-local")).toBe("");
    expect(fs.readdirSync(projectDirFor(env, `${project}/.worktrees/fix_login`))).toEqual([]);
    // The clone is untouched.
    expect(fs.readFileSync(`${clone}/README.md`, "utf8")).toBe("changed\n");
    expect(fs.readFileSync(`${clone}/PLAN.md`, "utf8")).toBe("the plan\n");
    expect(sh(clone, "symbolic-ref", "--short", "HEAD")).toBe("feature");
  });

  it("carries a staged rename over as a rename, not a copy", async () => {
    const { env, project, clone, box } = scenario();
    write(`${clone}/SYNTHETIC_old.txt`, "renamed content\n");
    sh(clone, "add", "SYNTHETIC_old.txt");
    sh(clone, "commit", "-q", "-m", "SYNTHETIC file to rename");
    sh(clone, "mv", "SYNTHETIC_old.txt", "renamed.txt");
    const plan = await planMigration({ env, box, primaryRepo: project });
    expect(plan.copyFiles).toContain("renamed.txt");
    expect(plan.removeFiles).toContain("SYNTHETIC_old.txt");
    await executeMigration({ env, box, plan, saveBox: () => undefined });
    const wt = `${project}/.worktrees/fix_login`;
    expect(fs.existsSync(`${wt}/renamed.txt`)).toBe(true);
    expect(fs.existsSync(`${wt}/SYNTHETIC_old.txt`)).toBe(false);
  });

  it("rolls back when it can't create a directory, so a retry can run", async () => {
    const { env, project, clone, box } = scenario();
    // A file where the worktree's notes directory must go.
    write(`${clone}/.aio`, "SYNTHETIC file in the way\n");
    sh(clone, "add", "-f", ".aio");
    sh(clone, "commit", "-q", "-m", "SYNTHETIC blocker");
    const plan = await planMigration({ env, box, primaryRepo: project });
    expect(plan.ok).toBe(true);
    await expect(
      executeMigration({ env, box, plan, saveBox: () => undefined }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/could not create/),
    });
    expect(fs.existsSync(`${project}/.worktrees/fix_login`)).toBe(false);
    expect(sh(project, "branch", "--list", "claude/fix_login")).toBe("");
  });

  it("throws conflict for a plan that is not ok", async () => {
    const { env, box } = scenario();
    const plan = await planMigration({ env, box, primaryRepo: undefined });
    await expect(
      executeMigration({ env, box, plan, saveBox: () => undefined }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "the project has no git repository to make a worktree from",
    });
  });
});
