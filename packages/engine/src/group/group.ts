// Deterministic grouping of the changed files (design.md, pre-push step 2).
import type { FileGroup, Hunk, PolicyFile } from "@aio/contracts";
import { isRiskPath } from "../policy/rules.js";
import type { DiffFile, DiffHunk } from "../range/diff.js";
import { fileKind, importedModules, importsFile, stem } from "./classify.js";

/** A group with at least this many changed lines is major. */
export const DEFAULT_MAJOR_LINES = 50;

export interface GroupOptions {
  policy: PolicyFile;
  /** Reads a file at the tip, or returns `null`. Used for import heuristics. */
  readFile: (path: string) => Promise<string | null>;
  majorLines?: number;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // The smaller path is the root, so the result doesn't depend on order.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

interface Slice {
  files: string[];
  hunks: Array<{ file: string; hunk: DiffHunk }>;
}

function lines(h: DiffHunk): number {
  return h.added + h.removed;
}

function sliceLines(slice: Slice): number {
  return slice.hunks.reduce((n, h) => n + lines(h.hunk), 0);
}

/** Splits a slice into slices of at most `limit` changed lines, by file, then by hunk. */
export function splitSlice(slice: Slice, limit: number): Slice[] {
  if (sliceLines(slice) <= limit) return [slice];
  const out: Slice[] = [];
  let current: Slice = { files: [], hunks: [] };
  let size = 0;
  const flush = () => {
    if (current.files.length > 0) out.push(current);
    current = { files: [], hunks: [] };
    size = 0;
  };
  for (const file of slice.files) {
    const hunks = slice.hunks.filter((h) => h.file === file);
    const fileSize = hunks.reduce((n, h) => n + lines(h.hunk), 0);
    if (fileSize > limit) {
      flush();
      for (const h of hunks) {
        if (size > 0 && size + lines(h.hunk) > limit) flush();
        if (!current.files.includes(file)) current.files.push(file);
        current.hunks.push(h);
        size += lines(h.hunk);
      }
      flush();
      continue;
    }
    if (size > 0 && size + fileSize > limit) flush();
    current.files.push(file);
    current.hunks.push(...hunks);
    size += fileSize;
  }
  flush();
  return out;
}

/**
 * Groups changed files with their related tests and docs, classifies each
 * group as major or minor, splits groups above the policy's size limit, and
 * gives every hunk an id. The same diff always gives the same groups.
 */
export async function groupFiles(
  files: readonly DiffFile[],
  options: GroupOptions,
): Promise<FileGroup[]> {
  const majorLines = options.majorLines ?? DEFAULT_MAJOR_LINES;
  const byPath = new Map(
    files.filter((f) => !f.binary || f.hunks.length > 0).map((f) => [f.path, f]),
  );
  const paths = [...byPath.keys()].sort();
  const sources = paths.filter((p) => fileKind(p) === "source");
  const tests = paths.filter((p) => fileKind(p) === "test");
  const docs = paths.filter((p) => fileKind(p) === "doc");

  const imports = new Map<string, string[]>();
  for (const p of [...sources, ...tests]) {
    const content = byPath.get(p)?.status === "deleted" ? null : await options.readFile(p);
    imports.set(p, content ? importedModules(p, content) : []);
  }

  const uf = new UnionFind();
  for (const p of paths) uf.find(p);
  for (const a of sources) {
    for (const b of sources) {
      if (a !== b && importsFile(imports.get(a) ?? [], b)) uf.union(a, b);
    }
  }

  const testsDirRoot = new Map<string, string>();
  for (const t of tests) {
    const match =
      sources.find((s) => importsFile(imports.get(t) ?? [], s)) ??
      sources.find((s) => stem(s) === stem(t));
    if (match) uf.union(match, t);
    else {
      // Tests with no changed source group together by directory.
      const dir = t.slice(0, t.lastIndexOf("/") + 1);
      const root = testsDirRoot.get(dir);
      if (root) uf.union(root, t);
      else testsDirRoot.set(dir, t);
    }
  }

  let docsRoot: string | null = null;
  for (const d of docs) {
    const content = byPath.get(d)?.status === "deleted" ? "" : ((await options.readFile(d)) ?? "");
    const lower = content.toLowerCase();
    const match =
      sources.find((s) => stem(s) === stem(d)) ??
      sources.find(
        (s) =>
          stem(s).length >= 4 && (lower.includes(s.toLowerCase()) || lower.includes(`${stem(s)}.`)),
      );
    if (match) uf.union(match, d);
    else if (docsRoot) uf.union(docsRoot, d);
    else docsRoot = d;
  }

  const components = new Map<string, string[]>();
  for (const p of paths) {
    const root = uf.find(p);
    const list = components.get(root) ?? [];
    list.push(p);
    components.set(root, list);
  }

  const kindOrder = { source: 0, test: 1, doc: 2 } as const;
  const slices: Slice[] = [];
  const ordered = [...components.values()].map((list) =>
    list.sort((a, b) => kindOrder[fileKind(a)] - kindOrder[fileKind(b)] || a.localeCompare(b)),
  );
  ordered.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
  for (const list of ordered) {
    const slice: Slice = { files: list, hunks: [] };
    for (const p of list) {
      const f = byPath.get(p);
      for (const h of f?.hunks ?? []) slice.hunks.push({ file: p, hunk: h });
    }
    slices.push(...splitSlice(slice, options.policy.groupSizeLimit));
  }

  return slices.map((slice, index) => {
    const id = `G${String(index + 1).padStart(2, "0")}`;
    const hunks: Hunk[] = slice.hunks.map((h, i) => ({
      id: `${id}-H${String(i + 1).padStart(2, "0")}`,
      file: h.file,
      start: h.hunk.start,
      end: h.hunk.end,
    }));
    const changedLines = sliceLines(slice);
    // A renamed file stays risky when either of its paths matches.
    const riskPath = slice.files.some((f) =>
      [f, byPath.get(f)?.oldPath].some((p) => p && isRiskPath(options.policy, p)),
    );
    return {
      id,
      files: slice.files,
      kind: riskPath || changedLines >= majorLines ? "major" : "minor",
      changedLines,
      riskPath,
      hunks,
    } satisfies FileGroup;
  });
}
