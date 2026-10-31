import { describe, expect, it } from "vitest";
import { parseDiff, unquote } from "../../src/range/diff.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3 +3,2 @@ function f() {
-  return 1;
+  if (x) return 2;
+  return 1;
@@ -10,2 +10,0 @@
-gone();
-gone();
diff --git a/new.py b/new.py
new file mode 100644
--- /dev/null
+++ b/new.py
@@ -0,0 +1,3 @@
+a
+b
+c
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/x.js b/y.js
similarity index 90%
rename from x.js
rename to y.js
--- a/x.js
+++ b/y.js
@@ -1 +1 @@
-a
+b
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

describe("parseDiff", () => {
  const files = parseDiff(DIFF);

  it("reads files, statuses, and counts", () => {
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["src/a.ts", "modified", 2, 3],
      ["new.py", "added", 3, 0],
      ["old.txt", "deleted", 0, 1],
      ["y.js", "renamed", 1, 1],
      ["img.png", "modified", 0, 0],
    ]);
    expect(files[3]?.oldPath).toBe("x.js");
    expect(files[4]?.binary).toBe(true);
  });

  it("gives tip-side line ranges, with deletions at the line before", () => {
    expect(files[0]?.hunks.map((h) => [h.start, h.end])).toEqual([
      [3, 4],
      [10, 10],
    ]);
    expect(files[1]?.hunks[0]).toMatchObject({ start: 1, end: 3, added: 3 });
  });
});

describe("parseDiff content lines that look like headers", () => {
  it("counts a removed `-- ` line and an added `++ ` line as changes", () => {
    const text = [
      "diff --git a/db/migrate.sql b/db/migrate.sql",
      "index 1111111..2222222 100644",
      "--- a/db/migrate.sql",
      "+++ b/db/migrate.sql",
      "@@ -1,3 +1,3 @@",
      " CREATE TABLE t (id int);",
      "--- legacy index",
      "+++ x",
      " SELECT 1;",
      "",
    ].join("\n");
    const [file] = parseDiff(text);
    expect(file).toMatchObject({ path: "db/migrate.sql", oldPath: "db/migrate.sql" });
    expect(file?.added).toBe(1);
    expect(file?.removed).toBe(1);
  });
});

describe("parseDiff quoted paths", () => {
  it("decodes octal escapes in non-ASCII paths, binary files included", () => {
    const text = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      "index 1111111..2222222 100644",
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      'diff --git "a/\\346\\227\\245\\346\\234\\254.png" "b/\\346\\227\\245\\346\\234\\254.png"',
      "index 1111111..2222222 100644",
      'Binary files "a/\\346\\227\\245\\346\\234\\254.png" and "b/\\346\\227\\245\\346\\234\\254.png" differ',
      'diff --git a/plain.txt "b/tab\\there \\"q\\".txt"',
      "similarity index 100%",
      "rename from plain.txt",
      'rename to "tab\\there \\"q\\".txt"',
      "",
    ].join("\n");
    expect(parseDiff(text).map((f) => [f.path, f.oldPath, f.status])).toEqual([
      ["café.txt", "café.txt", "modified"],
      ["日本.png", "日本.png", "modified"],
      ['tab\there "q".txt', "plain.txt", "renamed"],
    ]);
  });

  it("leaves an unquoted path alone", () => {
    expect(unquote("a/caf\\303.txt")).toBe("a/caf\\303.txt");
    expect(unquote('"a\\\\b"')).toBe("a\\b");
  });
});

describe("parseDiff paths that hold ` b/`", () => {
  it("takes the path of a binary or mode-only change from the middle of the line", () => {
    const text = [
      "diff --git a/x b/y.png b/x b/y.png",
      "index 1111111..2222222 100644",
      "Binary files a/x b/y.png and b/x b/y.png differ",
      "diff --git a/x b/run.sh b/x b/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    expect(parseDiff(text).map((f) => [f.path, f.oldPath, f.binary])).toEqual([
      ["x b/y.png", "x b/y.png", true],
      ["x b/run.sh", "x b/run.sh", false],
    ]);
  });
});
