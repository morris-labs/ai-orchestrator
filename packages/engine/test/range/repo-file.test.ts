// Reading working-tree files by paths that reviewers supply.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../src/range/repo-file.js";
import { toCandidates } from "../../src/state/steps.js";
import { makeRun } from "../state/harness.js";
import { tempDir } from "../tmp.js";

describe("readRepoFile", () => {
  function repo(): { root: string; outside: string } {
    const top = tempDir("repo-file-");
    const root = join(top, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.py"), "print(1)\n");
    writeFileSync(join(top, "SYNTHETIC_secret.txt"), "outside\n");
    return { root, outside: join(top, "SYNTHETIC_secret.txt") };
  }

  it("reads a file inside the repository", async () => {
    const { root } = repo();
    expect(await readRepoFile(root, "src/a.py")).toBe("print(1)\n");
    expect(await readRepoFile(root, "src/../src/a.py")).toBe("print(1)\n");
  });

  it("refuses paths that leave the repository", async () => {
    const { root, outside } = repo();
    expect(await readRepoFile(root, "../SYNTHETIC_secret.txt")).toBeNull();
    expect(await readRepoFile(root, outside)).toBeNull();
    symlinkSync(outside, join(root, "link.txt"));
    expect(await readRepoFile(root, "link.txt")).toBeNull();
  });

  it("refuses devices and files over the size limit", async () => {
    const { root } = repo();
    const depth = root.split("/").length;
    const started = Date.now();
    expect(await readRepoFile(root, `${"../".repeat(depth)}dev/zero`)).toBeNull();
    symlinkSync("/dev/zero", join(root, "zero"));
    expect(await readRepoFile(root, "zero")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    writeFileSync(join(root, "big.txt"), "x".repeat(2048));
    expect(await readRepoFile(root, "big.txt", 1024)).toBeNull();
  });
});

describe("a reviewer's finding path", () => {
  it("can't make the engine read outside the repository in a working-tree round", async () => {
    const { ctx, repo } = await makeRun();
    ctx.state.round = 1;
    ctx.eng.includeWorktree = true;
    const depth = repo.split("/").length;
    const candidates = await toCandidates(
      ctx,
      [
        {
          finding: {
            severity: "P1" as const,
            title: "SYNTHETIC escape",
            file: `${"../".repeat(depth)}dev/zero`,
            lines: [1, 1] as [number, number],
            failure_case: "x",
            category: "logic",
            introduced: true,
            verdict: "pending" as const,
          },
          vendor: "codex" as const,
          model: "codex",
          groupId: null,
        },
      ],
      "reviewer",
      [],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.symbol).toBe("");
  });
});
