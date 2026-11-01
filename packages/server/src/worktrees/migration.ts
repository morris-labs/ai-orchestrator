// Convert to Worktree, ported from the 3.3.5 `WorktreeMigration.cpp`.
//
// Turns a workspace subfolder (an independent clone of the project's
// repository) into a git worktree of the primary repository while keeping the
// conversation resumable. Nothing is deleted: the worktree is built beside the
// old folder, transcripts are copied (never moved), and only after everything
// succeeds is the old folder renamed to `<slug>.pre-worktree`. Every commit
// (all branches, tags, and stashes), every uncommitted and ignored file, the
// local ignore rules, and the transcripts are carried over, so the old folder
// can then be deleted by hand. What cannot be carried (hooks and git settings
// only the clone has) is listed in the report. A failure before the record is
// saved removes only what this run created.
import fs from "node:fs";
import path from "node:path";
import type { Box, ConvertToWorktreeResult } from "@aio/contracts";
import { projectDirFor } from "../catalog/paths.js";
import { ApiError, messageOf } from "../records/errors.js";
import { homePaths, stamp, type HostEnv } from "../records/env.js";
import { git } from "./git.js";
import {
  addWorktree,
  branchFor,
  currentBranch,
  ensureExcluded,
  entryLeaf,
  infraFile,
  isBuildOutputName,
  isRepo,
  mergeExcludeRules,
  originUrl,
  topLevel,
  worktreeNotesDir,
  worktreePath,
} from "./worktrees.js";

/** The notes files an agent keeps at a folder's top level. */
const NOTES_NAMES = ["PLAN.md", "STATUS.md", "INFRA.md"];

export interface MigrationPlan {
  ok: boolean;
  /** Why the subfolder cannot be converted, when `ok` is false. */
  problem: string;
  /** `<project>/<slug>`, the clone. */
  oldDir: string;
  /** The primary repository. */
  repo: string;
  slug: string;
  /** The new branch, `claude/<slug>`. */
  branch: string;
  /** The branch the clone has checked out. */
  cloneBranch: string;
  /** `<repo>/.worktrees/<slug>`. */
  worktree: string;
  /** `<worktree>/.aio`. */
  notesDir: string;
  /** `claude-keep/<slug>/`, under which the clone's other commits are kept. */
  keepPrefix: string;
  /** Relative paths copied from the clone. */
  copyFiles: string[];
  /** Relative paths deleted in the clone, removed in the worktree. */
  removeFiles: string[];
  /** Ignored build output, copied only with `includeBuildOutput`. */
  skippedIgnored: string[];
  includeBuildOutput: boolean;
  /** Size of `skippedIgnored` in bytes. */
  skippedBytes: number;
  /** The clone's other branches that exist nowhere else. */
  keepBranches: string[];
  /** Tags the repository lacks. */
  keepTags: string[];
  /** Stash commits, kept as branches. */
  keepStashes: string[];
  /** Lines of the clone's `info/exclude` to merge. */
  excludeRules: number;
  /** Hooks and git settings that are not carried over. */
  cloneOnly: string[];
  /** PLAN.md, STATUS.md, and INFRA.md copied to the notes locations. */
  notesFiles: string[];
  /** Transcript file names to copy. */
  transcripts: string[];
  /** The project directory the transcripts are in now. */
  transcriptFrom: string;
  /** Where Claude looks for them from the worktree. */
  transcriptTo: string;
  /** Whether the box's own session transcript exists. */
  ownTranscriptFound: boolean;
}

function emptyPlan(): MigrationPlan {
  return {
    ok: false,
    problem: "",
    oldDir: "",
    repo: "",
    slug: "",
    branch: "",
    cloneBranch: "",
    worktree: "",
    notesDir: "",
    keepPrefix: "",
    copyFiles: [],
    removeFiles: [],
    skippedIgnored: [],
    includeBuildOutput: false,
    skippedBytes: 0,
    keepBranches: [],
    keepTags: [],
    keepStashes: [],
    excludeRules: 0,
    cloneOnly: [],
    notesFiles: [],
    transcripts: [],
    transcriptFrom: "",
    transcriptTo: "",
    ownTranscriptFound: true,
  };
}

/**
 * Normalizes a remote URL to host and path, lowercased, so the ssh and https
 * spellings of one repository compare equal.
 */
export function normalizeUrl(input: string): string {
  let url = input.trim().replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  const at = url.indexOf("@");
  const limit = url.includes("/") ? url.indexOf("/") : url.length - 1;
  if (at >= 0 && at < limit) url = url.slice(at + 1);
  url = url.replace(/^([^/:]+):(?!\/\/)/, "$1/");
  url = url.replace(/\/+$/, "");
  if (url.endsWith(".git")) url = url.slice(0, -4);
  return url.toLowerCase();
}

/**
 * Parses `git status --porcelain=v1 -z` into status codes and paths. A
 * rename or copy also carries its source path as `from`.
 */
export function parseStatus(raw: string): { xy: string; path: string; from?: string }[] {
  const out: { xy: string; path: string; from?: string }[] = [];
  const parts = raw.split("\0").filter((p) => p !== "");
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i] as string;
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    // A rename or copy is followed by its source path as a separate field.
    if (xy.includes("R") || xy.includes("C")) {
      const from = parts[i + 1];
      i += 1;
      out.push(from === undefined ? { xy, path: p.slice(3) } : { xy, path: p.slice(3), from });
    } else {
      out.push({ xy, path: p.slice(3) });
    }
  }
  return out;
}

function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function sizeOfTree(dir: string): number {
  let total = 0;
  const st = lstat(dir);
  if (!st) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  for (const name of fs.readdirSync(dir)) total += sizeOfTree(path.join(dir, name));
  return total;
}

/** Copies a file, directory, or symbolic link; a link keeps its own text. */
export function copyTree(from: string, to: string): void {
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) {
    fs.rmSync(to, { force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // The link's own text: a relative link must stay relative, or it breaks
    // when the old folder is renamed.
    fs.symlinkSync(fs.readlinkSync(from), to);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyTree(path.join(from, name), path.join(to, name));
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { force: true });
  fs.copyFileSync(from, to);
}

function readTrimmedLines(file: string): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim());
  } catch {
    return [];
  }
}

async function configKeys(dir: string): Promise<Set<string>> {
  const c = await git(dir, ["config", "--local", "--name-only", "--list"]);
  return new Set(c.output.split("\n").filter((k) => k !== ""));
}

const IGNORED_CONFIG_PREFIXES = [
  "remote.",
  "branch.",
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.symlinks",
  "core.precomposeunicode",
  "submodule.",
];

/** Works out what converting `box`'s workspace subfolder would do. */
export async function planMigration(input: {
  env: HostEnv;
  box: Box;
  primaryRepo: string | undefined;
  includeBuildOutput?: boolean;
}): Promise<MigrationPlan> {
  const { env, box } = input;
  const p = emptyPlan();
  p.includeBuildOutput = input.includeBuildOutput ?? false;
  const fail = (why: string) => {
    p.problem = why;
    return p;
  };

  if (box.workspace === undefined) return fail("this box does not work in a workspace subfolder");
  if (box.worktree !== undefined) return fail("this box already works in a worktree");

  p.repo = input.primaryRepo ?? "";
  if (p.repo === "" || !(await isRepo(p.repo))) {
    return fail("the project has no git repository to make a worktree from");
  }

  p.slug = box.workspace;
  p.oldDir = path.posix.normalize(`${box.targetDir}/${box.workspace}`);
  if (!lstat(p.oldDir)?.isDirectory()) return fail(`${p.oldDir} does not exist`);

  // Must be a repository of its own: a plain directory inside the project's
  // repository reports the project as its top level.
  if ((await topLevel(p.oldDir)) !== p.oldDir) {
    return fail("the folder is not an independent git clone");
  }

  const cloneUrl = normalizeUrl(await originUrl(p.oldDir));
  const repoUrl = normalizeUrl(await originUrl(p.repo));
  if (cloneUrl === "" || cloneUrl !== repoUrl) {
    return fail(
      `the folder is a clone of a different repository (${cloneUrl || "no origin"} and ${repoUrl || "no origin"})`,
    );
  }

  p.cloneBranch = await currentBranch(p.oldDir);
  if (p.cloneBranch === "") return fail("the clone has a detached HEAD; check out a branch first");

  p.branch = branchFor(p.slug);
  p.worktree = worktreePath(p.repo, p.slug);
  p.notesDir = worktreeNotesDir(p.worktree);
  p.keepPrefix = `claude-keep/${p.slug}/`;

  // Commits that exist only in the clone. A commit already reachable from a
  // branch or remote of the repository is safe and skipped.
  const preserved = async (sha: string): Promise<boolean> => {
    if (!(await git(p.repo, ["cat-file", "-e", `${sha}^{commit}`])).ok) return false;
    const c = await git(p.repo, [
      "for-each-ref",
      "--contains",
      sha,
      "--count=1",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ]);
    return c.ok && c.output !== "";
  };
  const branches = await git(p.oldDir, [
    "for-each-ref",
    "--format=%(refname:short) %(objectname)",
    "refs/heads",
  ]);
  for (const line of branches.output.split("\n").filter((l) => l !== "")) {
    const sp = line.lastIndexOf(" ");
    const name = line.slice(0, sp);
    const sha = line.slice(sp + 1);
    if (name !== p.cloneBranch && !(await preserved(sha))) p.keepBranches.push(name);
  }
  const tags = await git(p.oldDir, ["for-each-ref", "--format=%(refname:short)", "refs/tags"]);
  for (const t of tags.output.split("\n").filter((l) => l !== "")) {
    if (!(await git(p.repo, ["show-ref", "--verify", "--quiet", `refs/tags/${t}`])).ok) {
      p.keepTags.push(t);
    }
  }
  const stashes = await git(p.oldDir, ["stash", "list", "--format=%H"]);
  p.keepStashes = stashes.output.split("\n").filter((l) => l !== "");

  // The clone's own ignore rules, so copied ignored files stay ignored.
  const cloneExclude = `${p.oldDir}/.git/info/exclude`;
  if (fs.existsSync(cloneExclude)) {
    const rp = await git(p.repo, ["rev-parse", "--git-common-dir"]);
    const common = path.isAbsolute(rp.output) ? rp.output : path.resolve(p.repo, rp.output);
    const have = readTrimmedLines(`${common}/info/exclude`);
    for (const line of readTrimmedLines(cloneExclude)) {
      if (line !== "" && !line.startsWith("#") && !have.includes(line)) p.excludeRules += 1;
    }
  }

  // What cannot be carried over: hooks and git settings only the clone has.
  try {
    for (const h of fs.readdirSync(`${p.oldDir}/.git/hooks`).sort()) {
      if (lstat(`${p.oldDir}/.git/hooks/${h}`)?.isFile() && !h.endsWith(".sample")) {
        p.cloneOnly.push(`hook ${h}`);
      }
    }
  } catch {
    // No hooks directory.
  }
  const repoKeys = await configKeys(p.repo);
  for (const k of await configKeys(p.oldDir)) {
    if (repoKeys.has(k) || IGNORED_CONFIG_PREFIXES.some((prefix) => k.startsWith(prefix))) continue;
    p.cloneOnly.push(`git setting ${k}`);
  }
  if (fs.existsSync(p.worktree)) return fail(`${p.worktree} already exists`);
  if ((await git(p.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${p.branch}`])).ok) {
    return fail(`the branch ${p.branch} already exists in the repository`);
  }

  // Working-tree state to carry over.
  const st = await git(p.oldDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    trim: false,
  });
  if (!st.ok) return fail(`git status failed: ${st.output}`);
  for (const e of parseStatus(st.output)) {
    const topLevelNote = !e.path.includes("/") && NOTES_NAMES.includes(e.path) && e.xy === "??";
    if (topLevelNote) {
      p.notesFiles.push(e.path);
      continue;
    }
    if (e.xy.includes("D") && !fs.existsSync(`${p.oldDir}/${e.path}`)) p.removeFiles.push(e.path);
    else p.copyFiles.push(e.path);
    // A rename's source is gone from the clone; left alone, the worktree
    // would keep it, and the rename would arrive as a copy.
    if (
      e.from !== undefined &&
      e.xy.includes("R") &&
      !fs.existsSync(`${p.oldDir}/${e.from}`) &&
      !p.removeFiles.includes(e.from)
    ) {
      p.removeFiles.push(e.from);
    }
  }
  // A committed notes file stays in the worktree, and is also copied to the
  // notes directory that the new prompt points at.
  for (const n of NOTES_NAMES) {
    if (!p.notesFiles.includes(n) && fs.existsSync(`${p.oldDir}/${n}`)) p.notesFiles.push(n);
  }

  // Ignored files (.env and the like) carry real state; build output does not.
  const ig = await git(
    p.oldDir,
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    { trim: false },
  );
  if (ig.ok) {
    for (const entry of ig.output.split("\0").filter((e) => e !== "")) {
      if (isBuildOutputName(entryLeaf(entry))) {
        p.skippedIgnored.push(entry);
        p.skippedBytes += sizeOfTree(`${p.oldDir}/${entry.replace(/\/$/, "")}`);
      } else {
        p.copyFiles.push(entry);
      }
    }
  }

  // Transcripts: the box's own conversation is under the project root, where
  // its container ran; anything started inside the folder is under its own.
  p.transcriptFrom = projectDirFor(env, box.targetDir);
  p.transcriptTo = projectDirFor(env, p.worktree);
  const names = new Set<string>();
  p.ownTranscriptFound = false;
  if (box.sessionUuid !== null) {
    const own = `${box.sessionUuid}.jsonl`;
    p.ownTranscriptFound = fs.existsSync(path.join(p.transcriptFrom, own));
    if (p.ownTranscriptFound) names.add(own);
  }
  try {
    const folderProject = projectDirFor(env, p.oldDir);
    for (const n of fs.readdirSync(folderProject)) {
      if (n.endsWith(".jsonl") && lstat(path.join(folderProject, n))?.isFile()) names.add(n);
    }
  } catch {
    // The folder has no transcripts of its own.
  }
  p.transcripts = [...names].sort();

  p.ok = true;
  return p;
}

/** The plan as lines for a person to read before confirming. */
export function planReport(plan: MigrationPlan): string[] {
  if (!plan.ok) return [`Cannot convert: ${plan.problem}`];
  const r: string[] = [];
  r.push(`Folder:      ${plan.oldDir} (branch ${plan.cloneBranch})`);
  r.push(`Worktree:    ${plan.worktree}`);
  r.push(`New branch:  ${plan.branch} (the clone's commits, including any not pushed)`);
  r.push(
    `Changes:     ${plan.copyFiles.length} file(s) copied over, ${plan.removeFiles.length} deletion(s) applied`,
  );
  r.push(
    `Notes:       ${plan.notesFiles.length === 0 ? "nothing" : plan.notesFiles.join(", ")} copied to ${plan.notesDir}`,
  );
  if (plan.keepBranches.length > 0 || plan.keepTags.length > 0 || plan.keepStashes.length > 0) {
    r.push(
      `Also kept:   ${plan.keepBranches.length} other branch(es), ${plan.keepTags.length} tag(s), ` +
        `${plan.keepStashes.length} stash(es), as branches and tags under ${plan.keepPrefix} in the repository`,
    );
  }
  if (plan.excludeRules > 0) {
    r.push(
      `Ignore rules: ${plan.excludeRules} line(s) from the clone's own exclude file are added to the repository's`,
    );
  }
  if (plan.skippedIgnored.length > 0) {
    r.push(
      `Build output: ${plan.skippedIgnored.join(", ")} (${Math.floor(plan.skippedBytes / (1024 * 1024))} MB) ` +
        (plan.includeBuildOutput
          ? "will be copied"
          : "is NOT copied; rebuild it, or tick the box to copy it"),
    );
  }
  r.push(`Transcripts: ${plan.transcripts.length} file(s) copied to ${plan.transcriptTo}`);
  if (!plan.ownTranscriptFound) {
    r.push("Warning:     this box's own transcript was not found, so it will start a new session.");
  }
  if (plan.cloneOnly.length > 0) {
    r.push(`NOT carried over (set up again if you need them): ${plan.cloneOnly.join(", ")}`);
  }
  r.push(
    `Afterwards the old folder is renamed to ${plan.slug}.pre-worktree. Once this finishes, nothing in it ` +
      "is needed except what this report says was not carried over.",
  );
  r.push("Staged changes become unstaged changes in the worktree.");
  return r;
}

export type MigrationResult = ConvertToWorktreeResult & {
  /** Set when the conversion finished but the old folder could not be renamed. */
  warning?: string;
};

/**
 * Performs the conversion planned by `planMigration()` and persists the
 * updated box with `saveBox`. Throws `ApiError` (`conflict`) on failure, after
 * removing what this run created.
 */
export async function executeMigration(input: {
  env: HostEnv;
  box: Box;
  plan: MigrationPlan;
  saveBox: (box: Box) => void | Promise<void>;
  includeBuildOutput?: boolean;
}): Promise<MigrationResult> {
  const { env, box, plan } = input;
  const includeBuildOutput = input.includeBuildOutput ?? plan.includeBuildOutput;
  const fail = (msg: string): never => {
    throw new ApiError("conflict", msg);
  };
  if (!plan.ok) fail(plan.problem);

  // 1. A backup of the record, so the conversion can be undone by hand.
  const now = env.now();
  const runStamp = stamp(now);
  const backupDir = homePaths(env).backupDir;
  const recordBackup = path.join(backupDir, `${box.id}.${runStamp}`);
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(recordBackup, `${JSON.stringify(box, null, 2)}\n`, { flag: "wx" });
  } catch {
    fail("could not back up the box record");
  }

  // Undo for a failure before the record is saved: remove only what this run
  // created. The clone keeps its own commits.
  let createdBranch = false;
  let createdWorktree = false;
  const createdFiles: string[] = [];
  const createdRefs: string[] = [];
  const rollback = async () => {
    for (const ref of createdRefs) await git(plan.repo, ["update-ref", "-d", ref]);
    for (const f of createdFiles) fs.rmSync(f, { force: true });
    if (createdWorktree) {
      await git(plan.repo, ["worktree", "remove", "--force", plan.worktree]);
    }
    if (createdBranch) await git(plan.repo, ["branch", "-D", plan.branch]);
  };
  const failAfter = async (msg: string): Promise<never> => {
    await rollback();
    return fail(msg);
  };

  // 2. The clone's commits, as a branch of the primary repository.
  const ex = await ensureExcluded(plan.repo);
  if (!ex.ok) fail(`could not update info/exclude: ${ex.error ?? ""}`);
  const fetched = await git(
    plan.repo,
    ["fetch", plan.oldDir, `${plan.cloneBranch}:${plan.branch}`],
    {
      timeoutMs: 300000,
    },
  );
  if (!fetched.ok) fail(`could not fetch the clone's branch: ${fetched.output}`);
  createdBranch = true;

  // 2b. Everything else only the clone has: other branches, tags, stashes.
  const keepRef = async (source: string, ref: string) => {
    const r = await git(plan.repo, ["fetch", plan.oldDir, `${source}:${ref}`], {
      timeoutMs: 300000,
    });
    if (r.ok) createdRefs.push(ref);
    return r;
  };
  for (const b of plan.keepBranches) {
    const r = await keepRef(`refs/heads/${b}`, `refs/heads/${plan.keepPrefix}${b}`);
    if (!r.ok) await failAfter(`could not keep the branch ${b}: ${r.output}`);
  }
  for (const t of plan.keepTags) {
    const r = await keepRef(`refs/tags/${t}`, `refs/tags/${t}`);
    if (!r.ok) await failAfter(`could not keep the tag ${t}: ${r.output}`);
  }
  for (const [i, sha] of plan.keepStashes.entries()) {
    const r = await keepRef(sha, `refs/heads/${plan.keepPrefix}stash-${i}`);
    if (!r.ok) await failAfter(`could not keep stash ${i}: ${r.output}`);
  }
  await mergeExcludeRules(plan.repo, `${plan.oldDir}/.git/info/exclude`);

  // 3. The worktree on that branch.
  const added = await addWorktree(plan.repo, plan.slug);
  if (!added.ok) await failAfter(`could not create the worktree: ${added.error}`);
  createdWorktree = true;

  // 4. Uncommitted work and ignored configuration.
  const copyRel = async (rel: string) => {
    const bare = rel.replace(/\/$/, "");
    const src = `${plan.oldDir}/${bare}`;
    if (lstat(src) === undefined) return;
    try {
      copyTree(src, `${plan.worktree}/${bare}`);
    } catch {
      await failAfter(`could not copy ${src}`);
    }
  };
  for (const rel of plan.copyFiles) await copyRel(rel);
  if (includeBuildOutput) for (const rel of plan.skippedIgnored) await copyRel(rel);
  for (const rel of plan.removeFiles) {
    const target = `${plan.worktree}/${rel}`;
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target);
      } catch {
        await failAfter(`could not delete ${target}`);
      }
    }
  }

  // A directory this run needs; failing to make one rolls the run back, so
  // a retry doesn't find a half-made worktree in its way.
  const mkdirOrFail = async (dir: string) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      await failAfter(`could not create ${dir}: ${messageOf(err)}`);
    }
  };

  // 5. PLAN.md and STATUS.md go to the worktree's notes folder; INFRA.md is
  // the project's shared file.
  await mkdirOrFail(plan.notesDir);
  for (const n of plan.notesFiles) {
    const dst = n === "INFRA.md" ? infraFile(box.targetDir) : `${plan.notesDir}/${n}`;
    await mkdirOrFail(path.dirname(dst));
    if (!fs.existsSync(dst)) {
      try {
        fs.copyFileSync(`${plan.oldDir}/${n}`, dst);
      } catch {
        await failAfter(`could not copy ${n}`);
      }
      createdFiles.push(dst);
    }
  }

  // 6. Transcripts: copied, never moved, then size-checked.
  await mkdirOrFail(plan.transcriptTo);
  const folderProject = projectDirFor(env, plan.oldDir);
  for (const n of plan.transcripts) {
    let src = path.join(plan.transcriptFrom, n);
    if (!fs.existsSync(src)) src = path.join(folderProject, n);
    const dst = path.join(plan.transcriptTo, n);
    if (fs.existsSync(dst)) continue; // Already there; keep it.
    let copied: boolean;
    try {
      fs.copyFileSync(src, dst);
      copied = fs.statSync(src).size === fs.statSync(dst).size;
    } catch {
      copied = false;
    }
    if (!copied) {
      fs.rmSync(dst, { force: true });
      await failAfter(`could not copy the transcript ${n}`);
    }
    createdFiles.push(dst);
  }

  // 7. The record now points at the worktree.
  const updated: Box = {
    ...box,
    worktree: plan.worktree,
    branch: plan.branch,
    movedFrom: plan.oldDir,
    updatedAt: now.toISOString(),
  };
  delete updated.workspace;
  try {
    await input.saveBox(updated);
  } catch (err) {
    await failAfter(`could not save the box record: ${messageOf(err)}`);
  }

  // 8. Last: the old folder steps aside. The conversion is complete and
  // recorded, so a failure here is reported, not rolled back.
  let aside = `${plan.oldDir}.pre-worktree`;
  if (fs.existsSync(aside)) aside += `.${runStamp}`;
  const result: MigrationResult = {
    box: updated,
    worktree: plan.worktree,
    branch: plan.branch,
    oldFolder: aside,
    recordBackup,
    keptRefs: [...createdRefs],
    notCarried: [...plan.cloneOnly],
  };
  try {
    fs.renameSync(plan.oldDir, aside);
  } catch {
    result.oldFolder = plan.oldDir;
    result.warning = `converted, but could not rename ${plan.oldDir}; rename or remove it yourself`;
  }
  return result;
}
