// The Developer context pack: what a task's seat needs to start without
// surveying the repository. Code assembles it from the plan and the
// worktree when the task's first attempt starts:
//
//   - the task's excerpt of the build plan: the build title, the
//     architecture, the task's milestone, and the task's own entry
//   - the task's acceptance criteria
//   - the current contents of the task's contract files
//   - the current contents of the task's owned files, with globs expanded
//
// The pack bounds its size. A file over `PACK_FILE_LIMIT` characters, a
// binary file, and every file past `PACK_TOTAL_LIMIT` characters of file
// contents go in by reference: their path, size, and line count, for the
// agent to read from the worktree when it needs them. A glob lists at most
// `PACK_LIST_LIMIT` files.
//
// The engine saves the pack as `tasks/TASK/pack.md`, with its key in
// `tasks/TASK/pack.json`. Every later attempt at the task reuses the saved
// pack, so a retry and a restarted engine send the same text. A plan
// amendment that changes the task's entry, such as its owned files,
// changes the key, and the next attempt gets a fresh pack.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BuildTask } from "@aio/contracts";
import type { BuildContext } from "./context.js";
import { isPathGlob, pathMatcher } from "./paths.js";

/** The most characters of one file that the pack includes; a larger file goes in by reference. */
export const PACK_FILE_LIMIT = 24_000;

/** The most characters of file contents in one pack, about 30K tokens. */
export const PACK_TOTAL_LIMIT = 120_000;

/** The most files that one glob lists in the pack. */
export const PACK_LIST_LIMIT = 200;

/** The architecture characters the excerpt includes; the rest stays in `plan.json`. */
const ARCHITECTURE_LIMIT = 8_000;

/** How the agent uses the pack, at the top of every pack. */
export const PACK_GUIDANCE = [
  "The engine built this pack from the build plan and the worktree when the task started. It holds what the task needs. Don't survey the repository: start from the pack, and read another file only when the pack names it, the code in the pack imports it, or a test fails in it.",
  "The pack shows each file as it was when the task started. On a later attempt, the worktree holds your earlier work, so read a file from the worktree again before you change it.",
].join("\n\n");

/** What `tasks/TASK/pack.json` records. */
interface PackRecord {
  /** The hash of the task entry and plan parts the pack came from. */
  key: string;
  /** The worktree's `HEAD` when the engine built the pack. */
  head: string;
  /** The files whose contents the pack includes. */
  inline: string[];
  /** The files the pack names by reference. */
  referenced: string[];
}

function packKey(ctx: BuildContext, task: BuildTask): string {
  const milestone = ctx.plan.milestones.find((m) => m.tasks.includes(task.id)) ?? null;
  const criteria = ctx.plan.criteria.filter((c) => task.criteria.includes(c.id));
  const source = JSON.stringify({
    task,
    milestone,
    criteria,
    title: ctx.plan.title,
    architecture: ctx.plan.architecture,
  });
  return createHash("sha256").update(source).digest("hex");
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
}

/** The task's excerpt of the build plan. */
function planExcerpt(ctx: BuildContext, task: BuildTask): string {
  const plan = ctx.plan;
  const lines = [`Build: ${plan.title}`];
  const milestone = plan.milestones.find((m) => m.tasks.includes(task.id));
  if (milestone)
    lines.push(`Milestone ${milestone.id}: ${milestone.title}. Goal: ${milestone.goal}`);
  lines.push("", `Task ${task.id}: ${task.title}`, "", task.description.trim());
  if (task.dependsOn.length > 0) {
    const titles = task.dependsOn.map(
      (id) => `${id} (${plan.tasks.find((t) => t.id === id)?.title ?? "unknown"})`,
    );
    lines.push("", `Builds on: ${titles.join(", ")}. Their work is on the branch.`);
  }
  if (task.tests.length > 0) lines.push("", `Tests that must pass: ${task.tests.join(", ")}`);
  if (plan.sharedFiles.length > 0) lines.push("", `Shared files: ${plan.sharedFiles.join(", ")}`);
  if (plan.architecture) {
    const text = plan.architecture.trim();
    const cut =
      text.length > ARCHITECTURE_LIMIT
        ? `${text.slice(0, ARCHITECTURE_LIMIT)}\n\n[The architecture goes on in the build's plan.json file.]`
        : text;
    lines.push("", "Architecture:", "", cut);
  }
  return lines.join("\n");
}

/** The repository files that `entries` name: each plain path, and each glob's matches. */
async function expand(
  ctx: BuildContext,
  entries: readonly string[],
): Promise<{ paths: string[]; notes: string[] }> {
  const paths: string[] = [];
  const notes: string[] = [];
  let known: string[] | null = null;
  for (const entry of entries) {
    if (!isPathGlob(entry)) {
      paths.push(entry);
      continue;
    }
    known ??= [
      ...(await ctx.worktree.git.run(["ls-files", "-z"])).split("\0"),
      ...(await ctx.worktree.untracked()),
    ].filter((p) => p !== "");
    const match = pathMatcher([entry]);
    const found = [...new Set(known.filter(match))].sort();
    paths.push(...found.slice(0, PACK_LIST_LIMIT));
    if (found.length === 0) notes.push(`- \`${entry}\`: no file matches yet.`);
    if (found.length > PACK_LIST_LIMIT) {
      notes.push(
        `- \`${entry}\`: ${found.length - PACK_LIST_LIMIT} more files match; list them in the worktree.`,
      );
    }
  }
  return { paths: [...new Set(paths)], notes };
}

/** Builds the pack's file sections, within the size limits. */
class FileBlocks {
  used = 0;
  readonly inline: string[] = [];
  readonly referenced: string[] = [];

  constructor(private readonly root: string) {}

  /** The pack text for `path`: its contents, or a line that names it. */
  async render(path: string): Promise<string> {
    const full = join(this.root, path);
    let size: number;
    try {
      const info = await stat(full);
      if (!info.isFile()) return `- \`${path}\`: not a file.`;
      size = info.size;
    } catch {
      return `- \`${path}\`: doesn't exist yet; the task creates it if it needs it.`;
    }
    const data = await readFile(full);
    if (data.includes(0)) {
      this.referenced.push(path);
      return `- \`${path}\`: a binary file of ${sizeText(size)}; left out.`;
    }
    const text = data.toString("utf8");
    const lines = lineCount(text).toLocaleString("en-US");
    if (text.length > PACK_FILE_LIMIT) {
      this.referenced.push(path);
      return `- \`${path}\`: ${sizeText(size)}, ${lines} lines; too large for the pack, so read the parts you need from the worktree.`;
    }
    if (this.used + text.length > PACK_TOTAL_LIMIT) {
      this.referenced.push(path);
      return `- \`${path}\`: ${sizeText(size)}, ${lines} lines; the pack is full, so read it from the worktree.`;
    }
    this.used += text.length;
    this.inline.push(path);
    return `<file path="${path}">\n${text.trimEnd()}\n</file>`;
  }
}

async function build(
  ctx: BuildContext,
  task: BuildTask,
  key: string,
): Promise<{ text: string; record: PackRecord }> {
  const criteria = new Map(ctx.plan.criteria.map((c) => [c.id, c.text]));
  const files = new FileBlocks(ctx.worktree.path);
  const contracts = (await expand(ctx, task.contracts)).paths;
  const owned = await expand(ctx, task.ownedFiles);
  const contractBlocks: string[] = [];
  for (const path of contracts) contractBlocks.push(await files.render(path));
  const ownedBlocks: string[] = [];
  for (const path of owned.paths.filter((p) => !contracts.includes(p))) {
    ownedBlocks.push(await files.render(path));
  }
  const text = [
    PACK_GUIDANCE,
    "### Build plan excerpt",
    planExcerpt(ctx, task),
    "### Acceptance criteria",
    task.criteria.map((id) => `- ${id}: ${criteria.get(id) ?? ""}`).join("\n"),
    "### Contract files",
    contractBlocks.join("\n\n") || "The task implements no contract files.",
    "### Owned files",
    [...ownedBlocks, ...owned.notes].join("\n\n"),
  ].join("\n\n");
  return {
    text,
    record: {
      key,
      head: await ctx.worktree.head(),
      inline: files.inline,
      referenced: files.referenced,
    },
  };
}

/**
 * The context pack for `task`: the saved one when the task's plan entry
 * hasn't changed since the engine built it, else a fresh one, saved.
 */
export async function taskPack(ctx: BuildContext, task: BuildTask): Promise<string> {
  const key = packKey(ctx, task);
  const recordPath = ctx.store.path("tasks", task.id, "pack.json");
  const textPath = ctx.store.path("tasks", task.id, "pack.md");
  const saved = await ctx.store.readJson<PackRecord>(recordPath);
  if (saved?.key === key) {
    try {
      return await readFile(textPath, "utf8");
    } catch {
      // A pack whose text a stop kept from being saved is built again.
    }
  }
  const { text, record } = await build(ctx, task, key);
  await ctx.store.writeText(textPath, text);
  await ctx.store.writeJson(recordPath, record);
  return text;
}
