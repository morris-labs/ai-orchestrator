// Parses `git diff -U0` output into files and hunks.

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** First and last changed line in the tip version; a pure deletion gives the line before it. */
  start: number;
  end: number;
  added: number;
  removed: number;
}

export interface DiffFile {
  /** Path in the tip version, or the old path for a deleted file. */
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return path;
}

function stripPrefix(path: string): string | null {
  const p = unquote(path.trim());
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/** Parses a unified diff. Context lines are tolerated but don't count as changes. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      file = {
        path: m?.[2] ?? "",
        oldPath: m?.[1] ?? null,
        status: "modified",
        binary: false,
        added: 0,
        removed: 0,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("rename from "))
      file.oldPath = unquote(line.slice("rename from ".length));
    else if (line.startsWith("Binary files ")) file.binary = true;
    else if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4));
      file.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4));
      if (p !== null) file.path = p;
    } else if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (!m) continue;
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      hunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        start: newStart,
        end: newCount === 0 ? newStart : newStart + newCount - 1,
        added: 0,
        removed: 0,
      };
      file.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith("+")) {
        hunk.added += 1;
        file.added += 1;
      } else if (line.startsWith("-")) {
        hunk.removed += 1;
        file.removed += 1;
      }
    }
  }
  for (const f of files) {
    if (f.status === "deleted" && f.oldPath) f.path = f.oldPath;
    if (f.status !== "renamed" && f.oldPath === f.path)
      f.oldPath = f.status === "added" ? null : f.oldPath;
  }
  return files.filter((f) => f.path !== "");
}
