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
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const DIFF_GIT_RE = new RegExp(`^diff --git (${QUOTED}|a/.+?) (${QUOTED}|b/.+)$`);

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * Reverses git's C-style quoting of a path, which git uses for a path with
 * a control character, a quote, a backslash, or (with the default
 * `core.quotePath`) any non-ASCII byte, written as octal escapes such as
 * `\303\251` for `é`.
 */
export function unquote(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const chars = Array.from(path.slice(1, -1));
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const octal = chars.slice(i + 1, i + 4).join("");
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const code = ESCAPES[chars[i + 1] ?? ""];
    if (code !== undefined) {
      bytes.push(code);
      i += 1;
      continue;
    }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString("utf8");
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
      // Each side is a plain `a/PATH` or a quoted `"a/PATH"`.
      const m = DIFF_GIT_RE.exec(line);
      file = {
        path: (m?.[2] && stripPrefix(m[2])) ?? "",
        oldPath: (m?.[1] && stripPrefix(m[1])) ?? null,
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
    if (line.startsWith("@@")) {
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
      continue;
    }
    if (hunk) {
      // Inside a hunk every line is content, even one that starts with
      // `--- ` or `+++ `, such as a removed SQL comment.
      if (line.startsWith("+")) {
        hunk.added += 1;
        file.added += 1;
      } else if (line.startsWith("-")) {
        hunk.removed += 1;
        file.removed += 1;
      }
      continue;
    }
    // The file header: between `diff --git` and the first hunk.
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("rename from "))
      file.oldPath = unquote(line.slice("rename from ".length));
    else if (line.startsWith("Binary files ")) file.binary = true;
    else if (line.startsWith("--- ")) {
      file.oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4));
      if (p !== null) file.path = p;
    }
  }
  for (const f of files) {
    if (f.status === "deleted" && f.oldPath) f.path = f.oldPath;
    if (f.status !== "renamed" && f.oldPath === f.path)
      f.oldPath = f.status === "added" ? null : f.oldPath;
  }
  return files.filter((f) => f.path !== "");
}
