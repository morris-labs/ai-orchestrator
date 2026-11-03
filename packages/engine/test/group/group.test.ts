import { DEFAULT_POLICY, PolicyFileSchema } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { fileKind, importedModules, importsFile, stem } from "../../src/group/classify.js";
import { groupFiles, splitSlice } from "../../src/group/group.js";
import type { DiffFile, DiffHunk } from "../../src/range/diff.js";

function hunk(start: number, added: number): DiffHunk {
  return {
    oldStart: start,
    oldCount: 0,
    newStart: start,
    newCount: added,
    start,
    end: start + added - 1,
    added,
    removed: 0,
  };
}

function file(path: string, ...hunks: DiffHunk[]): DiffFile {
  const added = hunks.reduce((n, h) => n + h.added, 0);
  return { path, oldPath: path, status: "modified", binary: false, added, removed: 0, hunks };
}

describe("classify", () => {
  it.each([
    ["src/a.ts", "source"],
    ["src/a.test.ts", "test"],
    ["tests/test_orders.py", "test"],
    ["pkg/a_test.go", "test"],
    ["README.md", "doc"],
    ["docs/guide.txt", "doc"],
  ])("%s is %s", (path, kind) => {
    expect(fileKind(path)).toBe(kind);
  });

  it("strips test markers from stems", () => {
    expect(stem("tests/test_orders.py")).toBe("orders");
    expect(stem("src/orders.spec.ts")).toBe("orders");
    expect(stem("src/Orders.ts")).toBe("orders");
  });

  it("reads JS and Python imports", () => {
    const js = importedModules(
      "src/a/b.ts",
      `import { x } from "../c.js";\nconst y = require("./d");`,
    );
    expect(importsFile(js, "src/c.ts")).toBe(true);
    expect(importsFile(js, "src/a/d.ts")).toBe(true);
    const py = importedModules(
      "tests/test_x.py",
      "from shop.inventory import page\nimport shop.pricing\n",
    );
    expect(importsFile(py, "shop/inventory.py")).toBe(true);
    expect(importsFile(py, "shop/pricing.py")).toBe(true);
    expect(importsFile(py, "shop/reports.py")).toBe(false);
  });
});

describe("groupFiles", () => {
  const contents: Record<string, string> = {
    "src/orders.ts": `import { tax } from "./tax.js";`,
    "src/tax.ts": "export const tax = 1;",
    "src/ui.ts": "export {}",
    "src/orders.test.ts": `import { x } from "./orders.js";`,
    "docs/ui.md": "The ui module draws things.",
    "CHANGELOG.md": "misc",
  };
  const readFile = async (p: string) => contents[p] ?? null;
  const files = [
    file("src/ui.ts", hunk(1, 10)),
    file("src/orders.ts", hunk(1, 30), hunk(50, 30)),
    file("src/tax.ts", hunk(1, 5)),
    file("src/orders.test.ts", hunk(1, 5)),
    file("docs/ui.md", hunk(1, 2)),
    file("CHANGELOG.md", hunk(1, 1)),
  ];

  it("groups sources that import each other with their tests and docs", async () => {
    const groups = await groupFiles(files, { policy: DEFAULT_POLICY, readFile });
    expect(groups.map((g) => g.files)).toEqual([
      ["CHANGELOG.md"],
      ["src/orders.ts", "src/tax.ts", "src/orders.test.ts"],
      ["src/ui.ts", "docs/ui.md"],
    ]);
    expect(groups.map((g) => g.id)).toEqual(["G01", "G02", "G03"]);
    expect(groups[1]?.kind).toBe("major");
    expect(groups[1]?.changedLines).toBe(70);
    expect(groups[2]?.kind).toBe("minor");
    expect(groups[1]?.hunks.map((h) => h.id)).toEqual(["G02-H01", "G02-H02", "G02-H03", "G02-H04"]);
  });

  it("is deterministic regardless of input order", async () => {
    const a = await groupFiles(files, { policy: DEFAULT_POLICY, readFile });
    const b = await groupFiles([...files].reverse(), { policy: DEFAULT_POLICY, readFile });
    expect(b).toEqual(a);
  });

  it("makes a risk path major and splits oversized groups", async () => {
    const policy = PolicyFileSchema.parse({
      version: 1,
      riskPaths: ["src/ui.ts"],
      groupSizeLimit: 40,
    });
    const groups = await groupFiles(files, { policy, readFile });
    const ui = groups.find((g) => g.files.includes("src/ui.ts"));
    expect(ui?.kind).toBe("major");
    expect(ui?.riskPath).toBe(true);
    for (const g of groups) expect(g.changedLines).toBeLessThanOrEqual(40);
    // orders.ts alone has 60 changed lines, so its hunks split across groups.
    expect(groups.filter((g) => g.files.includes("src/orders.ts"))).toHaveLength(2);
  });

  it("makes a file renamed out of a risk path major", async () => {
    const policy = PolicyFileSchema.parse({ version: 1, riskPaths: ["src/auth/**"] });
    const renamed: DiffFile = {
      ...file("src/misc/tokens.ts", hunk(1, 1)),
      oldPath: "src/auth/tokens.ts",
      status: "renamed",
    };
    const [group] = await groupFiles([renamed], { policy, readFile: async () => null });
    expect(group?.kind).toBe("major");
    expect(group?.riskPath).toBe(true);
  });

  it("splits by file, then by hunk", () => {
    const slice = {
      files: ["a", "b"],
      hunks: [
        { file: "a", hunk: hunk(1, 10) },
        { file: "b", hunk: hunk(1, 30) },
        { file: "b", hunk: hunk(40, 30) },
      ],
    };
    expect(splitSlice(slice, 100)).toHaveLength(1);
    const parts = splitSlice(slice, 35);
    expect(parts.map((p) => p.hunks.length)).toEqual([1, 1, 1]);
  });
});
