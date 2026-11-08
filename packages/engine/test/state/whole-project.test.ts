// A whole-project run on a real repository, with no Git identity configured:
// the engine-owned base, exclusions, verdicts, round 2, resume, and refs.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunTokenEstimate } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import type {
  AdapterRequest,
  AdapterResult,
  CommandOptions,
  CommandRunner,
  EngineDeps,
  VendorAdapter,
} from "../../src/core.js";
import { GrantingBroker, MemoryEventSink } from "../../src/core.js";
import { silentLogger } from "../../src/main/logger.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { Git } from "../../src/range/git.js";
import { RunController } from "../../src/state/controller.js";
import { EngineRunManager } from "../../src/state/manager.js";
import { tempDir } from "../tmp.js";
import { contextOf, makeRun } from "./harness.js";

/** Hides every Git setting outside the repository from one command, and no more. */
class NoIdentityRunner implements CommandRunner {
  private readonly inner = new ExecaRunner();
  run(program: string, args: readonly string[], options: CommandOptions) {
    return this.inner.run(program, args, {
      ...options,
      env: { ...options.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  }
}

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const FILES: Record<string, string> = {
  "src/app.js": "export function app() {\n  return 1;\n}\n",
  "src/util.js": "export const util = 2;\n",
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "web/lib.min.js": "var a=1;\n",
  "pkg/dist/out.js": "var b=2;\n",
  "vendor/dep.js": "var c=3;\n",
  "policy-skip/a.js": "var d=4;\n",
  "run-skip/a.js": "var e=5;\n",
};

/** A repository with one commit, whose config forbids guessing a Git identity. */
function makeRepo(): string {
  const repo = tempDir("aio-whole-");
  git(repo, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Example", "-c", "user.email=dev@example.com", "commit", "-qm", "One");
  git(repo, "config", "user.useConfigOnly", "true");
  writeFileSync(join(repo, ".git/info/exclude"), ".aio/\n");
  mkdirSync(join(repo, ".aio"), { recursive: true });
  writeFileSync(join(repo, ".aio/policy.yaml"), "version: 1\nexcludePaths:\n  - policy-skip/**\n");
  return repo;
}

function answer<T>(output: T): AdapterResult<T> {
  return {
    output,
    model: "fake",
    sessionId: null,
    tokens: { in: 1, out: 1 },
    usage: [],
    premiumRequests: 0,
    costEstimate: 0,
  } as unknown as AdapterResult<T>;
}

interface Log {
  reviews: string[];
  verifies: AdapterRequest[];
  clusters: string[];
  failVerify: boolean;
}

/** Reports one flaw in `src/app.js` and calls it present at the base; the fixer commits. */
function adapter(vendor: "claude" | "codex" | "copilot", log: Log): VendorAdapter {
  const unused = () => Promise.reject(new Error("unused"));
  const verdict = {
    verdict: "confirmed",
    verification: "code-reading",
    evidence: "app returns a constant for every input.",
    presentAtBase: true,
    script: null,
  };
  return {
    vendor,
    review: (request: AdapterRequest) => {
      log.reviews.push(request.prompt);
      const hunks = [...new Set(request.prompt.match(/G\d+-H\d+/g) ?? [])];
      const hit = request.prompt.includes("src/app.js");
      const first = !log.reviews.slice(0, -1).some((p) => p.includes("src/app.js"));
      return Promise.resolve(
        answer({
          findings:
            hit && first
              ? [
                  {
                    severity: "P1",
                    title: "app returns a constant",
                    file: "src/app.js",
                    lines: [2, 2],
                    failure_case: "Any call gets 1, so callers read the wrong value.",
                    category: "correctness",
                    introduced: false,
                  },
                ]
              : [],
          ledger: hunks.map((hunkId) => ({ hunkId, verdict: "sound", reason: "Read it." })),
        }),
      );
    },
    continueReview: unused,
    verify: (request: AdapterRequest) => {
      log.verifies.push(request);
      if (log.failVerify) return Promise.reject(new Error("The disprover crashed."));
      return Promise.resolve(answer(verdict));
    },
    verifyBatch: (request: AdapterRequest) => {
      log.verifies.push(request);
      if (log.failVerify) return Promise.reject(new Error("The disprover crashed."));
      const ids = request.prompt.match(/^### (\S+)$/gm) ?? [];
      return Promise.resolve(
        answer({ verdicts: ids.map((h) => ({ id: h.slice(4), ...verdict })) }),
      );
    },
    fix: (request: AdapterRequest) => {
      const path = join(request.repoPath, "src/app.js");
      writeFileSync(path, readFileSync(path, "utf8").replace("return 1;", "return app.value;"));
      git(request.repoPath, "add", "-A");
      git(
        request.repoPath,
        "-c",
        "user.name=Example",
        "-c",
        "user.email=dev@example.com",
        "commit",
        "-qm",
        "Fix",
      );
      const ids = [...request.prompt.matchAll(/^- (F-\d+) /gm)].map((m) => m[1] as string);
      return Promise.resolve(answer({ fixed: ids, notFixed: [], summary: "Fixed." }));
    },
    confirm: () => Promise.resolve(answer({ incomplete: [], findings: [] })),
    sweep: () => Promise.resolve(answer({ findings: [] })),
    cluster: (request: AdapterRequest) => {
      log.clusters.push(request.prompt);
      const ids = [...new Set(request.prompt.match(/\bF-\d{4,}\b/g) ?? [])];
      return Promise.resolve(
        answer({
          causes: [{ title: "One cause", summary: "Shared.", findingIds: ids, fixOrder: 1 }],
          rationale: "Only one.",
        }),
      );
    },
    detectLimit: () => null,
  } as unknown as VendorAdapter;
}

function adapters(log: Log): EngineDeps["adapters"] {
  return {
    claude: adapter("claude", log),
    codex: adapter("codex", log),
    copilot: adapter("copilot", log),
  };
}

const newLog = (): Log => ({ reviews: [], verifies: [], clusters: [], failVerify: false });

const refs = (repo: string) => git(repo, "for-each-ref");

const WHOLE = {
  scope: "whole",
  excludePaths: ["run-skip/**"],
  base: "does-not-exist",
  crossVendor: false,
};

async function start(repo: string, log: Log, request: Record<string, unknown>) {
  const made = await makeRun({
    repo,
    adapters: adapters(log),
    deps: { runner: new NoIdentityRunner() },
    request: { ...WHOLE, tip: "main", ...request },
  });
  await made.run.start();
  return made;
}

describe("the empty base", () => {
  it("has a fixed SHA, no parent, and no ref, with no Git identity", async () => {
    const repo = makeRepo();
    const before = refs(repo);
    const base = new Git(new NoIdentityRunner(), repo);
    const sha = await base.emptyBaseCommit();
    expect(await base.emptyBaseCommit()).toBe(sha);
    expect(git(repo, "rev-list", "--parents", "-1", sha)).toBe(sha);
    expect(git(repo, "ls-tree", sha)).toBe("");
    expect(refs(repo)).toBe(before);
    // A second repository gets the same commit, since nothing in it varies.
    expect(await new Git(new NoIdentityRunner(), makeRepo()).emptyBaseCommit()).toBe(sha);
  });

  it("gives the same files as a full diff, with no project text", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 2, 0, 3]));
    writeFileSync(join(repo, "empty.txt"), "");
    writeFileSync(join(repo, "with\ttab.js"), "a\nb\n");
    git(repo, "add", "-A");
    git(
      repo,
      "-c",
      "user.name=Example",
      "-c",
      "user.email=dev@example.com",
      "commit",
      "-qm",
      "Two",
    );
    const client = new Git(new ExecaRunner(), repo);
    const { parseDiff } = await import("../../src/range/diff.js");
    const base = await client.emptyBaseCommit();
    const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1);
    const counted = (await client.addedFiles(base, "HEAD")).sort(byPath);
    const full = parseDiff(await client.diff(base, "HEAD")).sort(byPath);
    expect(counted).toEqual(full);
  });
});

describe("the preview of a whole-project run", () => {
  it("counts exclusions, lists them, estimates tokens, and adds no ref", async () => {
    const repo = makeRepo();
    git(repo, "update-ref", "refs/remotes/origin/main", "main");
    const before = refs(repo);
    const runs = new EngineRunManager({
      projectRoot: repo,
      container: "c",
      events: new MemoryEventSink("engine:test", "s"),
      leases: new GrantingBroker(),
      adapters: {},
      log: silentLogger,
    });
    const preview = await runs.preview({
      projectId: "p",
      repoPath: repo,
      base: "does-not-exist",
      tip: "origin/main",
      readOnly: true,
      mergeBase: false,
      exactBase: false,
      pipeline: "pre-push",
      profile: "offload",
      includeWorktree: false,
      crossVendor: true,
      roundCap: 2,
      continuationCap: 0,
      overlapThreshold: 0.5,
      depth: "standard",
      scope: "whole",
      excludePaths: ["run-skip/**"],
    });
    expect(preview.groups.flatMap((g) => g.files).sort()).toEqual(["src/app.js", "src/util.js"]);
    expect(preview.changedLines).toBe(4);
    expect(preview.tokenEstimate?.tokens).toBeGreaterThan(0);
    expect(preview.excluded?.count).toBe(6);
    expect(preview.excluded?.files).toContainEqual({ path: "run-skip/a.js", source: "run" });
    expect(preview.excluded?.files).toContainEqual({ path: "policy-skip/a.js", source: "policy" });
    expect(preview.excluded?.files).toContainEqual({ path: "vendor/dep.js", source: "built-in" });
    expect(refs(repo)).toBe(before);
    await runs.close();
  });

  it("charges verification to the cross-vendor verifier (F-0022)", async () => {
    const repo = makeRepo();
    git(repo, "update-ref", "refs/remotes/origin/main", "main");
    const runs = new EngineRunManager({
      projectRoot: repo,
      container: "c",
      events: new MemoryEventSink("engine:test", "s"),
      leases: new GrantingBroker(),
      // The preview checks only which vendors have an adapter.
      adapters: { claude: {} as never, codex: {} as never },
      log: silentLogger,
    });
    const preview = await runs.preview({
      projectId: "p",
      repoPath: repo,
      base: "does-not-exist",
      tip: "origin/main",
      readOnly: true,
      mergeBase: false,
      exactBase: false,
      pipeline: "pre-push",
      profile: "offload",
      roles: { reviewer: ["claude"] },
      includeWorktree: false,
      crossVendor: true,
      roundCap: 2,
      continuationCap: 0,
      overlapThreshold: 0.5,
      depth: "standard",
      scope: "whole",
    });
    // The API schema leaves `byVendor` out, but the engine's preview keeps it.
    const estimate = preview.tokenEstimate as RunTokenEstimate | undefined;
    const vendors = estimate?.byVendor.map((v) => v.vendor);
    expect(vendors).toEqual(["claude", "codex"]);
    await runs.close();
  });
});

describe("a whole-project run", () => {
  it("confirms a flaw at the base with introduced unknown, and reviews only the fix in round 2", async () => {
    const repo = makeRepo();
    const before = refs(repo);
    const log = newLog();
    const { run, ctx } = await start(repo, log, { depth: "standard" });
    await run.settled();
    expect(ctx.state.status).toBe("finished");
    const finding = ctx.findings[0];
    expect(finding).toMatchObject({ verdict: "fixed", introduced: null });
    expect(finding?.history.some((h) => h.verdict === "pre-existing")).toBe(false);

    const first = log.reviews.filter((p) => /in round 1 /.test(p)).join("\n");
    expect(first).toContain("src/app.js");
    for (const path of Object.keys(FILES).filter((p) => !p.startsWith("src/"))) {
      expect(first).not.toContain(path);
    }
    const second = log.reviews.filter((p) => /in round 2/.test(p));
    expect(second.length).toBeGreaterThan(0);
    expect(second.join("\n")).toContain("only what the fixer changed");
    expect(second.join("\n")).not.toContain("src/util.js");

    const prompt = log.verifies[0]?.prompt ?? "";
    expect(prompt).not.toMatch(/checkout of the base|Base \(|the tip and the base|in untouched/);
    expect(log.verifies[0]?.extraDirs).toBeUndefined();
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    // The fixer's commit moved `main`; nothing else appeared.
    expect(refs(repo).split("\n").length).toBe(before.split("\n").length);
  });

  it("finishes at the thorough depth with a read-only remote tip", async () => {
    const repo = makeRepo();
    git(repo, "update-ref", "refs/remotes/origin/feature", "main");
    const before = refs(repo);
    const log = newLog();
    const { run, ctx } = await start(repo, log, {
      depth: "thorough",
      readOnly: true,
      tip: "origin/feature",
    });
    await run.settled();
    expect(ctx.state.status).toBe("finished");
    expect(ctx.findings[0]).toMatchObject({ verdict: "confirmed", introduced: null });
    expect(log.reviews.join("\n")).not.toContain("the whole diff");
    expect(refs(repo)).toBe(before);
  });

  it("ends with a root-cause summary only when the request asks for one", async () => {
    const log = newLog();
    const { run, ctx } = await start(makeRepo(), log, {
      depth: "thorough",
      readOnly: true,
      rootCauses: true,
    });
    await run.settled();
    expect(ctx.state.status).toBe("finished");
    expect(log.clusters).toHaveLength(1);
    expect(ctx.state.rootCauses?.causes).toEqual([
      { title: "One cause", summary: "Shared.", findingIds: ["F-0001"], fixOrder: 1 },
    ]);
    const plain = newLog();
    const other = await start(makeRepo(), plain, { depth: "thorough", readOnly: true });
    await other.run.settled();
    expect(plain.clusters).toHaveLength(0);
    expect(other.ctx.state.rootCauses).toBeUndefined();
  });

  it("retries after a garbage collection removed the base", async () => {
    const repo = makeRepo();
    const log = newLog();
    log.failVerify = true;
    const { run, ctx, deps } = await start(repo, log, { depth: "standard" });
    await run.settled();
    expect(ctx.state.status).toBe("failed");
    const id = ctx.state.id;
    const baseSha = ctx.state.baseSha as string;

    git(repo, "reflog", "expire", "--expire=now", "--all");
    git(repo, "gc", "-q", "--prune=now");
    expect(() =>
      execFileSync("git", ["cat-file", "-e", baseSha], { cwd: repo, stdio: "pipe" }),
    ).toThrow();

    log.failVerify = false;
    const loaded = await RunController.load(id, { projectRoot: repo }, deps);
    await loaded.retry();
    await loaded.settled();
    expect(contextOf(loaded).state.status).toBe("finished");
    expect(contextOf(loaded).state.baseSha).toBe(baseSha);
    expect(contextOf(loaded).findings[0]).toMatchObject({ verdict: "fixed", introduced: null });
    git(repo, "cat-file", "-e", baseSha);
  });
});

describe("exclusions at the range scope", () => {
  it("apply the policy and the run's globs, but not the built-in list", async () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", base);
    git(repo, "checkout", "-qb", "work");
    for (const path of ["src/app.js", "policy-skip/a.js", "run-skip/a.js", "vendor/dep.js"]) {
      writeFileSync(join(repo, path), "changed\n");
    }
    git(repo, "add", "-A");
    git(
      repo,
      "-c",
      "user.name=Example",
      "-c",
      "user.email=dev@example.com",
      "commit",
      "-qm",
      "Two",
    );
    const runs = new EngineRunManager({
      projectRoot: repo,
      container: "c",
      events: new MemoryEventSink("engine:test", "s"),
      leases: new GrantingBroker(),
      adapters: {},
      log: silentLogger,
    });
    const preview = await runs.preview({
      projectId: "p",
      repoPath: repo,
      base: "origin/main",
      readOnly: true,
      mergeBase: true,
      exactBase: false,
      pipeline: "pre-push",
      profile: "offload",
      includeWorktree: false,
      crossVendor: true,
      roundCap: 2,
      continuationCap: 0,
      overlapThreshold: 0.5,
      depth: "standard",
      excludePaths: ["run-skip/**"],
    });
    expect(preview.groups.flatMap((g) => g.files).sort()).toEqual(["src/app.js", "vendor/dep.js"]);
    expect(preview.excluded?.count).toBe(2);
    await runs.close();
  });

  it("refuse a glob that can't compile", async () => {
    const repo = makeRepo();
    const runs = new EngineRunManager({
      projectRoot: repo,
      container: "c",
      events: new MemoryEventSink("engine:test", "s"),
      leases: new GrantingBroker(),
      adapters: {},
      log: silentLogger,
    });
    await expect(
      runs.preview({
        projectId: "p",
        repoPath: repo,
        base: "main",
        tip: "main",
        readOnly: true,
        mergeBase: false,
        exactBase: false,
        pipeline: "pre-push",
        profile: "offload",
        includeWorktree: false,
        crossVendor: true,
        roundCap: 2,
        continuationCap: 0,
        overlapThreshold: 0.5,
        depth: "standard",
        excludePaths: ["{broken"],
      }),
    ).rejects.toThrow(/without its/);
    await runs.close();
  });
});
