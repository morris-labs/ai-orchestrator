// The task gate's permission check: changed paths outside the seat's
// writable globs fail it, except paths exempted by their exact name.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { outsideWritable, runTaskGate } from "../../src/build/gate.js";
import { BuildWorktree } from "../../src/build/worktree.js";
import { ExecaRunner, ShellRunner } from "../../src/range/exec.js";
import { buildSampleRepo } from "../state/scenario.js";

describe("outsideWritable", () => {
  it("matches writable paths as globs and exempt paths literally", () => {
    const changed = ["src/cart.mjs", "notes/*.md", "notes/dev.md", "test/[a].mjs", "test/a.mjs"];

    expect(outsideWritable(changed, ["src/*.mjs"], ["notes/*.md", "test/[a].mjs"])).toEqual([
      "notes/dev.md",
      "test/a.mjs",
    ]);
  });

  it("matches a writable path with brackets as that exact path, not a character class", () => {
    const changed = ["app/[slug]/page.ts", "app/s/page.ts", "app/[id]/view.ts", "app/i/view.ts"];

    expect(outsideWritable(changed, ["app/[slug]/page.ts", "app/[id]/*.ts"])).toEqual([
      "app/s/page.ts",
      "app/i/view.ts",
    ]);
  });
});

describe("runTaskGate", () => {
  it("sets aside a later task's test whose path has brackets while the suite runs", async () => {
    const repo = buildSampleRepo();
    const tree = new BuildWorktree(
      new ExecaRunner(),
      repo,
      BuildWorktree.pathFor(repo, "brackets"),
      BuildWorktree.branchFor("brackets"),
    );
    const base = await tree.resolveBase(undefined);
    await tree.create(base);
    mkdirSync(join(tree.path, "app/[slug]"), { recursive: true });
    writeFileSync(join(tree.path, "app/[slug]/page.test.mjs"), "process.exit(1);\n");

    const gate = await runTaskGate({
      worktree: tree,
      base,
      writable: ["app/**"],
      commands: {
        test: [{ command: "test ! -e app/*/page.test.mjs" }],
        typecheck: [],
        lint: [],
      },
      shell: new ShellRunner(new ExecaRunner()),
      pending: ["app/[slug]/page.test.mjs"],
    });

    expect(gate.setAside).toEqual(["app/[slug]/page.test.mjs"]);
    expect(gate.commands.map((c) => c.passed)).toEqual([true]);
  });
});
