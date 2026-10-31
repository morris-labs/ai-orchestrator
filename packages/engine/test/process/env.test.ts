import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execRunner } from "../../src/api/runner.js";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import {
  childEnv,
  copilotTokenProblem,
  isClassicGitHubToken,
  isWithheld,
  profileForProgram,
} from "../../src/process/env.js";
import { ProcessRunner, ShellRunner } from "../../src/range/exec.js";
import { Git } from "../../src/range/git.js";
import { VerifyOutputSchema } from "../../src/core.js";

const BASE = {
  PATH: "/usr/bin",
  HOME: "/home/user",
  AGENTBOX_ENGINE_TOKEN: "engine-token-0123456789",
  AGENTBOX_SERVER_SECRET: "x",
  GH_TOKEN: "gh",
  ANTHROPIC_API_KEY: "sk-ant",
  ANTHROPIC_BASE_URL: "https://example.com",
  OPENAI_API_KEY: "sk-openai",
  CODEX_HOME: "/home/user/.codex",
  NPM_TOKEN: "npm",
  AWS_SECRET_ACCESS_KEY: "aws",
  LANG: "C.UTF-8",
};

describe("Copilot tokens", () => {
  it("drops classic tokens from Copilot's environment only", () => {
    const base = { ...BASE, GH_TOKEN: "ghp_classic", GITHUB_TOKEN: "gho_oauth" };
    const copilot = childEnv("vendor:copilot", {}, base);
    expect(copilot.GH_TOKEN).toBeUndefined();
    expect(copilot.GITHUB_TOKEN).toBe("gho_oauth");
    expect(childEnv("github", {}, base).GH_TOKEN).toBe("ghp_classic");
    const extra = childEnv("vendor:copilot", { COPILOT_GITHUB_TOKEN: "ghp_x" }, BASE);
    expect(extra.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(extra.GH_TOKEN).toBe("gh");
  });

  it("recognizes classic tokens", () => {
    expect(isClassicGitHubToken("ghp_abc")).toBe(true);
    expect(isClassicGitHubToken("github_pat_abc")).toBe(false);
    expect(isClassicGitHubToken(undefined)).toBe(false);
  });

  it("explains a classic token with no usable token beside it", () => {
    expect(copilotTokenProblem({ GH_TOKEN: "ghp_secret" })).toMatch(
      /GH_TOKEN holds a classic personal access token .*COPILOT_GITHUB_TOKEN/,
    );
    expect(copilotTokenProblem({ GH_TOKEN: "ghp_secret" })).not.toContain("ghp_secret");
    expect(
      copilotTokenProblem({ GH_TOKEN: "ghp_secret" }, { COPILOT_GITHUB_TOKEN: "github_pat_x" }),
    ).toBeNull();
    expect(copilotTokenProblem({})).toBeNull();
  });
});

describe("childEnv", () => {
  it("never passes the engine's own variables", () => {
    for (const profile of ["untrusted", "github", "vendor:claude", "vendor:copilot"] as const) {
      const env = childEnv(profile, {}, BASE);
      expect(env.AGENTBOX_ENGINE_TOKEN).toBeUndefined();
      expect(env.AGENTBOX_SERVER_SECRET).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin");
      expect(env.LANG).toBe("C.UTF-8");
    }
  });

  it("gives untrusted code no credentials", () => {
    const env = childEnv("untrusted", {}, BASE);
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH"]);
  });

  it("gives git and gh the GitHub token only", () => {
    const env = childEnv("github", {}, BASE);
    expect(env.GH_TOKEN).toBe("gh");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
  });

  it("gives a vendor CLI its own credentials and settings only", () => {
    const claude = childEnv("vendor:claude", {}, BASE);
    expect(claude.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(claude.ANTHROPIC_BASE_URL).toBe("https://example.com");
    expect(claude.OPENAI_API_KEY).toBeUndefined();
    expect(claude.CODEX_HOME).toBeUndefined();
    expect(claude.GH_TOKEN).toBeUndefined();
    const codex = childEnv("vendor:codex", {}, BASE);
    expect(codex.OPENAI_API_KEY).toBe("sk-openai");
    expect(codex.CODEX_HOME).toBe("/home/user/.codex");
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
    const copilot = childEnv("vendor:copilot", {}, BASE);
    expect(copilot.GH_TOKEN).toBe("gh");
    expect(copilot.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("applies the caller's additions and removals last", () => {
    const env = childEnv("untrusted", { EXTRA: "1", HOME: undefined }, BASE);
    expect(env.EXTRA).toBe("1");
    expect(env.HOME).toBeUndefined();
  });

  it("classifies names", () => {
    expect(isWithheld("MY_DB_PASSWORD", "untrusted")).toBe(true);
    expect(isWithheld("TOKENIZER_PATH", "untrusted")).toBe(false);
    expect(profileForProgram("gh")).toBe("github");
    expect(profileForProgram("python3")).toBe("untrusted");
  });

  it("gives the GitHub token only to the git commands that talk to a remote", () => {
    expect(profileForProgram("/usr/bin/git", ["push", "origin", "main"])).toBe("github");
    expect(profileForProgram("git", ["-C", "/repo", "-c", "a=b", "fetch", "-q"])).toBe("github");
    expect(profileForProgram("git", ["ls-remote", "origin"])).toBe("github");
    expect(profileForProgram("git", ["rev-parse", "HEAD"])).toBe("untrusted");
    expect(profileForProgram("git", ["-c", "core.hooksPath=/dev/null", "worktree", "add"])).toBe(
      "untrusted",
    );
    // A path that names a network command isn't the subcommand.
    expect(profileForProgram("git", ["-C", "push", "status"])).toBe("untrusted");
    expect(profileForProgram("git")).toBe("untrusted");
  });

  it("passes the SSH agent's socket to git and gh only", () => {
    const base = { SSH_AUTH_SOCK: "/tmp/ssh-SYNTHETIC/agent.1" };
    expect(childEnv("github", {}, base).SSH_AUTH_SOCK).toBe(base.SSH_AUTH_SOCK);
    expect(childEnv("untrusted", {}, base).SSH_AUTH_SOCK).toBeUndefined();
    expect(childEnv("vendor:claude", {}, base).SSH_AUTH_SOCK).toBeUndefined();
  });
});

describe("runners", () => {
  const saved: Record<string, string | undefined> = {};
  const set = { AGENTBOX_ENGINE_TOKEN: "engine-token-0123456789", GH_TOKEN: "gh-secret" };
  beforeEach(() => {
    for (const [k, v] of Object.entries(set)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(set)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("keeps the engine token and GitHub token from shell commands", async () => {
    const r = await new ShellRunner().run("env", [], { cwd: "/" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("AGENTBOX_ENGINE_TOKEN");
    expect(r.stdout).not.toContain("gh-secret");
    expect(r.stdout).toContain("PATH=");
  });

  it("keeps the engine token from git but passes the GitHub token", async () => {
    const r = await new ProcessRunner().run("env", [], { cwd: "/", envProfile: "github" });
    expect(r.stdout).not.toContain("AGENTBOX_ENGINE_TOKEN");
    expect(r.stdout).toContain("GH_TOKEN=gh-secret");
  });

  it("keeps the GitHub token from local git commands", async () => {
    const calls: Array<{ args: readonly string[]; profile: string | undefined }> = [];
    const recorder = {
      run: async (_p: string, args: readonly string[], o: { envProfile?: string }) => {
        calls.push({ args, profile: o.envProfile });
        return { exitCode: 0, stdout: "abc\n", stderr: "", timedOut: false, notStarted: false };
      },
    };
    const git = new Git(recorder as never, "/");
    await git.revParse("HEAD");
    await git.show("HEAD", "a.py");
    expect(calls.map((c) => c.profile)).toEqual(["untrusted", "untrusted"]);
    expect(calls.every((c) => c.args.join(" ").startsWith("-c core.hooksPath=/dev/null "))).toBe(
      true,
    );
    // The default for a local command that bypasses `Git` is the same.
    const env = await new ProcessRunner().run("env", [], {
      cwd: "/",
      envProfile: profileForProgram("git", ["status"]),
    });
    expect(env.stdout).not.toContain("gh-secret");
  });

  it("keeps the engine token from the API's runner", async () => {
    const r = await execRunner.run("env", []);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("AGENTBOX_ENGINE_TOKEN");
    expect(r.stdout).not.toContain("gh-secret");
  });

  it("reports a missing program as not started with exit code 127", async () => {
    const r = await new ProcessRunner().run("/nonexistent/agentbox-x", [], { cwd: "/" });
    expect(r.notStarted).toBe(true);
    expect(r.exitCode).toBe(127);
    expect((await execRunner.run("/nonexistent/agentbox-x", [])).code).toBe(127);
  });

  it("kills the whole process group on a timeout", async () => {
    const r = await new ShellRunner().run("sleep 30 & echo $!; wait", [], {
      cwd: "/",
      timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
    const pid = Number(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("Claude --bare", () => {
  it("follows the child's environment, not the engine's", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    try {
      const req = {
        prompt: "x",
        cwd: "/",
        tools: "read-only" as const,
        timeoutMs: 1000,
        outputSchema: VerifyOutputSchema,
      };
      expect(new ClaudeAdapter().buildArgs(req)).toContain("--bare");
      const removed = new ClaudeAdapter({ env: { ANTHROPIC_API_KEY: undefined } });
      expect(removed.buildArgs(req)).not.toContain("--bare");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
