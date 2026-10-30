import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FindingInputSchema, type RoleAssignment } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import type { VerifyOutput } from "../../src/core.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { DEFAULT_POLICY } from "@agentbox/contracts";
import {
  chooseDisprover,
  classifyRun,
  decideVerdict,
  runReproScript,
  verifyFinding,
  type BaseWorktree,
} from "../../src/verify/verify.js";
import { tempDir } from "../tmp.js";

const roles: RoleAssignment = {
  reviewer: ["codex", "copilot"],
  disprover: "codex",
  confirmer: "codex",
  fixer: "claude",
};
const all = ["claude", "codex", "copilot"] as const;

function out(extra: Partial<VerifyOutput> = {}): VerifyOutput {
  return {
    verdict: "confirmed",
    verification: "script",
    evidence: "ran it",
    presentAtBase: false,
    script: null,
    ...extra,
  };
}

describe("chooseDisprover", () => {
  it("never picks the reporter with cross-vendor checks", () => {
    expect(
      chooseDisprover("copilot", roles, { crossVendor: true, available: all, profile: "offload" }),
    ).toBe("codex");
    expect(
      chooseDisprover("codex", roles, { crossVendor: true, available: all, profile: "offload" }),
    ).toBe("copilot");
    expect(
      chooseDisprover("codex", roles, {
        crossVendor: true,
        available: ["claude", "codex"],
        profile: "offload",
      }),
    ).toBe("claude");
    expect(
      chooseDisprover(
        "codex",
        { ...roles, disprover: "claude" },
        { crossVendor: true, available: all, profile: "fast" },
      ),
    ).toBe("claude");
    expect(
      chooseDisprover(null, roles, { crossVendor: true, available: all, profile: "offload" }),
    ).toBe("codex");
  });

  it("uses the reporter's vendor without cross-vendor checks", () => {
    expect(
      chooseDisprover("copilot", roles, { crossVendor: false, available: all, profile: "offload" }),
    ).toBe("copilot");
  });
});

describe("decideVerdict", () => {
  const run = (exitCode: number) => ({ exitCode, timedOut: false, output: "" });

  const disproof = out({
    verdict: "disproved",
    verification: "code-reading",
    evidence: "send() checks the attempt count on line 12 and stops after three tries.",
  });

  it("keeps a disproof with positive evidence", () => {
    expect(decideVerdict(disproof, null, null).verdict).toBe("disproved");
    // A failing test command isn't a tool failure.
    expect(decideVerdict(disproof, null, null, ["pytest: 1 failed"]).verdict).toBe("disproved");
  });

  it("passes an unverified answer through", () => {
    const d = decideVerdict(out({ verdict: "unverified", evidence: "x" }), null, null);
    expect(d.verdict).toBe("unverified");
  });

  it("refuses a disproof from a disprover that couldn't check", () => {
    // Round 3's Codex answer, word for word.
    const sandbox = out({
      verdict: "disproved",
      evidence: "Unverified, not demonstrated false: sandbox execution failed",
    });
    expect(decideVerdict(sandbox, null, null).verdict).toBe("unverified");
    const empty = decideVerdict(out({ verdict: "disproved", evidence: " " }), null, null);
    expect(empty.verdict).toBe("unverified");
    expect(empty.evidence).toContain("no evidence");
    const tools = decideVerdict(disproof, null, null, [
      "python3 -c 1: bwrap: No permissions to create a new namespace",
    ]);
    expect(tools.verdict).toBe("unverified");
    expect(tools.evidence).toMatch(/tools failed: .*bwrap/);
  });

  it("confirms by script when the engine's rerun reproduces at the tip only", () => {
    const d = decideVerdict(out({ script: { path: "r.py" } }), run(1), run(0));
    expect(d).toMatchObject({ verdict: "confirmed", verification: "script", introduced: true });
  });

  it("marks a flaw that reproduces at the base as pre-existing", () => {
    expect(decideVerdict(out({ script: { path: "r.py" } }), run(1), run(1))).toMatchObject({
      verdict: "pre-existing",
      introduced: false,
    });
    expect(
      decideVerdict(out({ verification: "code-reading", presentAtBase: true }), null, null).verdict,
    ).toBe("pre-existing");
  });

  it("falls back to code reading when the script doesn't reproduce", () => {
    const d = decideVerdict(out({ script: { path: "r.py" } }), run(0), null);
    expect(d).toMatchObject({ verdict: "confirmed", verification: "code-reading" });
    expect(d.evidence).toContain("didn't reproduce");
  });
});

describe("runReproScript", () => {
  it("runs a script against a directory and refuses one outside the scratch directory", async () => {
    const scratch = tempDir("agentbox-scratch-");
    writeFileSync(join(scratch, "r.sh"), 'test -f "$1/marker" && exit 1; exit 0\n');
    const repo = tempDir("agentbox-repo-");
    const runner = new ExecaRunner();
    expect(
      (await runReproScript(runner, scratch, { path: "r.sh", interpreter: "sh" }, repo)).exitCode,
    ).toBe(0);
    writeFileSync(join(repo, "marker"), "");
    expect(
      (await runReproScript(runner, scratch, { path: "r.sh", interpreter: "sh" }, repo)).exitCode,
    ).toBe(1);
    await expect(runReproScript(runner, scratch, { path: "../evil.sh" }, repo)).rejects.toThrow(
      /outside/,
    );
  });

  // Finding 48: the write used to follow a dangling link planted in the
  // scratch directory and create the file outside it.
  it("doesn't write script content through a dangling link", async () => {
    const root = tempDir("agentbox-verify-");
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const repo = tempDir("agentbox-repo-");
    const target = join(root, "outside.sh");
    symlinkSync(target, join(scratch, "r.sh"));
    const run = await runReproScript(
      new ExecaRunner(),
      scratch,
      { path: "r.sh", interpreter: "sh", content: "exit 1\n" },
      repo,
    );
    expect(existsSync(target)).toBe(false);
    expect(run.notStarted).toBe(true);
  });

  it("doesn't write script content through a linked directory", async () => {
    const root = tempDir("agentbox-verify-");
    const scratch = join(root, "scratch");
    const outside = join(root, "outside");
    mkdirSync(scratch);
    mkdirSync(outside);
    const repo = tempDir("agentbox-repo-");
    symlinkSync(outside, join(scratch, "dir"));
    await expect(
      runReproScript(
        new ExecaRunner(),
        scratch,
        { path: "dir/sub/r.sh", interpreter: "sh", content: "exit 1\n" },
        repo,
      ),
    ).rejects.toThrow(/not a directory/);
    expect(existsSync(join(outside, "sub"))).toBe(false);
  });

  it("creates the directories for script content inside the scratch directory", async () => {
    const scratch = tempDir("agentbox-scratch-");
    const repo = tempDir("agentbox-repo-");
    const run = await runReproScript(
      new ExecaRunner(),
      scratch,
      { path: "a/b/r.sh", interpreter: "sh", content: "exit 1\n" },
      repo,
    );
    expect(run.exitCode).toBe(1);
    expect(readFileSync(join(scratch, "a/b/r.sh"), "utf8")).toBe("exit 1\n");
  });
});

describe("classifyRun", () => {
  const r = (extra: Partial<Parameters<typeof classifyRun>[0]>) => ({
    exitCode: 0,
    timedOut: false,
    output: "",
    ...extra,
  });

  it("counts only exit 1 without crash output as a reproduction", () => {
    expect(classifyRun(r({ exitCode: 1 }))).toBe("reproduced");
    expect(classifyRun(r({ exitCode: 0 }))).toBe("clean");
    expect(classifyRun(r({ exitCode: 2 }))).toBe("failed");
    expect(classifyRun(r({ exitCode: 127, notStarted: true }))).toBe("failed");
    expect(classifyRun(r({ exitCode: 126 }))).toBe("failed");
    expect(classifyRun(r({ exitCode: 1, timedOut: true }))).toBe("failed");
    expect(classifyRun(r({ exitCode: 137, signal: "SIGKILL" }))).toBe("failed");
    expect(
      classifyRun(r({ exitCode: 1, output: "Traceback (most recent call last):\n  boom" })),
    ).toBe("failed");
  });
});

describe("decideVerdict with failed scripts", () => {
  const ran = (exitCode: number, extra = {}) => ({
    exitCode,
    timedOut: false,
    output: "",
    ...extra,
  });

  it("never makes a finding pre-existing because the script failed at the tip and the base", () => {
    const missing = ran(127, { notStarted: true });
    const d = decideVerdict(out({ script: { path: "r.sh" } }), missing, missing);
    expect(d).toMatchObject({
      verdict: "confirmed",
      verification: "code-reading",
      introduced: true,
    });
  });

  it("treats a base run that failed as introduced", () => {
    const d = decideVerdict(out({ script: { path: "r.sh" } }), ran(1), ran(2));
    expect(d).toMatchObject({ verdict: "confirmed", verification: "script", introduced: true });
  });

  it("ignores the base run when the tip didn't reproduce", () => {
    const d = decideVerdict(out({ script: { path: "r.sh" } }), ran(2), ran(1));
    expect(d.verdict).toBe("confirmed");
  });
});

describe("verifyFinding", () => {
  const finding = FindingInputSchema.parse({
    id: "F-0001",
    fingerprint: "f",
    severity: "P1",
    title: "Crash on empty input",
    file: "a.py",
    lines: [1, 2],
    failureCase: "Empty input crashes.",
    category: "crash",
    introduced: true,
    reportedBy: "copilot-x",
    verdict: "pending",
    evidence: "",
    runId: "01JC0000000000000000000001",
    round: 1,
    groupId: null,
    origin: "reviewer",
  });

  function deps(script: VerifyOutput["script"], scratch: string, repo: string, base: string) {
    return {
      runner: new ExecaRunner(),
      range: { repoPath: repo, baseSha: "b", tipSha: "t", tipRef: "main" },
      policy: DEFAULT_POLICY,
      baseWorktree: { ensure: () => Promise.resolve(base) } as unknown as BaseWorktree,
      scratchDirFor: () => scratch,
      timeoutMs: 1000,
      inScriptCheckout: <T>(side: "tip" | "base", fn: (dir: string) => Promise<T>) =>
        fn(side === "tip" ? repo : base),
      callDisprover: () =>
        Promise.resolve({ vendor: "codex" as const, model: "m", output: out({ script }) }),
    };
  }

  function dirs() {
    const root = tempDir("agentbox-verify-");
    const scratch = join(root, "scratch");
    const repo = join(root, "repo");
    const base = join(root, "base");
    for (const d of [scratch, repo, base]) mkdirSync(d);
    return { root, scratch, repo, base };
  }

  it("passes the call's tool errors to the verdict", async () => {
    const { scratch, repo, base } = dirs();
    const result = await verifyFinding(finding, "codex", {
      ...deps(null, scratch, repo, base),
      callDisprover: () =>
        Promise.resolve({
          vendor: "codex" as const,
          model: "m",
          output: out({
            verdict: "disproved",
            evidence: "The caller always passes a non-empty list, so the index is valid.",
          }),
          toolErrors: ["cat a.py: bwrap: No permissions to create a new namespace"],
        }),
    });
    expect(result?.decision.verdict).toBe("unverified");
  });

  it("keeps a confirmed finding when the script the disprover named doesn't exist", async () => {
    const { scratch, repo, base } = dirs();
    const result = await verifyFinding(
      finding,
      "codex",
      deps({ path: "repro.sh", interpreter: "sh" }, scratch, repo, base),
    );
    expect(result?.decision).toMatchObject({ verdict: "confirmed", verification: "code-reading" });
    expect(result?.baseRun).toBeNull();
  });

  it("keeps a confirmed finding when the script crashes at the tip and the base", async () => {
    const { scratch, repo, base } = dirs();
    writeFileSync(join(scratch, "r.py"), "raise RuntimeError('broken script')\n");
    const result = await verifyFinding(
      finding,
      "codex",
      deps({ path: "r.py", interpreter: "python3" }, scratch, repo, base),
    );
    expect(result?.decision.verdict).toBe("confirmed");
    expect(result?.decision.verification).toBe("code-reading");
  });

  it("writes the script text the disprover returned and runs it", async () => {
    const { scratch, repo, base } = dirs();
    const result = await verifyFinding(
      finding,
      "codex",
      deps({ path: "r.sh", interpreter: "sh", content: "exit 1\n" }, scratch, repo, base),
    );
    expect(result?.decision).toMatchObject({ verdict: "pre-existing", verification: "script" });
  });

  it("runs the script only in the engine's script checkouts, never in the checkout under review", async () => {
    const { root, scratch, repo, base } = dirs();
    const tipCopy = join(root, "tip-copy");
    const baseCopy = join(root, "base-copy");
    for (const d of [tipCopy, baseCopy]) mkdirSync(d);
    const sides: string[] = [];
    const result = await verifyFinding(finding, "codex", {
      ...deps(
        {
          path: "r.sh",
          interpreter: "sh",
          content: 'echo helper > "$1/SYNTHETIC_helper.txt"\nexit 1\n',
        },
        scratch,
        repo,
        base,
      ),
      inScriptCheckout: <T>(side: "tip" | "base", fn: (dir: string) => Promise<T>) => {
        sides.push(side);
        return fn(side === "tip" ? tipCopy : baseCopy);
      },
    });
    expect(sides).toEqual(["tip", "base"]);
    expect(result?.tipRun?.exitCode).toBe(1);
    expect(existsSync(join(repo, "SYNTHETIC_helper.txt"))).toBe(false);
    expect(existsSync(join(base, "SYNTHETIC_helper.txt"))).toBe(false);
    expect(existsSync(join(tipCopy, "SYNTHETIC_helper.txt"))).toBe(true);
  });

  it("stops a reproduction script when the run is cancelled", async () => {
    const { scratch, repo, base } = dirs();
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 200);
    await expect(
      verifyFinding(finding, "codex", {
        ...deps({ path: "r.sh", interpreter: "sh", content: "sleep 30\n" }, scratch, repo, base),
        signal: abort.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("refuses a script that links outside the scratch directory", async () => {
    const { root, scratch, repo } = dirs();
    writeFileSync(join(root, "evil.sh"), "exit 1\n");
    symlinkSync(join(root, "evil.sh"), join(scratch, "link.sh"));
    await expect(
      runReproScript(new ExecaRunner(), scratch, { path: "link.sh", interpreter: "sh" }, repo),
    ).rejects.toThrow(/outside/);
  });
});
