// The host-to-container path mapping at each place the server uses it, with
// the host OS injected so Linux runs the Windows and macOS cases.
import fs from "node:fs";
import path from "node:path";
import { ENGINE_ENV, type Box } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { baseClaudeArgs, movedMessage } from "../../src/boxes/args.js";
import { encodeProjectDir, projectDirFor, transcriptPath } from "../../src/catalog/paths.js";
import {
  buildLaunchSpec,
  mountBind,
  mountContainerPaths,
  toDockerRunArgs,
  type LaunchInput,
} from "../../src/docker/launch.js";
import { defaultProjectName, normalizeRoot, projectIdForRoot } from "../../src/projects/ids.js";
import {
  bindSource,
  defaultHostEnv,
  hostOsOf,
  hostToContainer,
  mirrorBind,
  promptPath,
  splitMountSpec,
  type HostEnv,
} from "../../src/records/env.js";
import { infraFile, worktreeNotesDir } from "../../src/worktrees/worktrees.js";
import { addWorktree } from "../../src/worktrees/index.js";
import { initRepo, tempDir } from "../worktrees/helpers.js";
import { makeHarness } from "../boxes/harness.js";

const LINUX_PATHS = [
  "/home/tester/work/app",
  "/home/tester/work/my app",
  "/tmp/claude-1000/a.b-c",
  "/srv/repo/",
  "/srv//repo/./x/..",
];

const linuxEnv: HostEnv = { home: "/home/tester", user: "tester", now: () => new Date() };
const winEnv: HostEnv = {
  home: "C:/Users/tester",
  user: "tester",
  now: () => new Date(),
  hostOs: "win32",
};
const C = "aio-agent-proj-app-1a2b3c4d";

describe("host OS in the environment", () => {
  it("defaults to linux and follows the injected platform", () => {
    expect(hostOsOf(linuxEnv)).toBe("linux");
    expect(hostOsOf(winEnv)).toBe("win32");
    expect(defaultHostEnv("win32").hostOs).toBe("win32");
    expect(defaultHostEnv("darwin").hostOs).toBe("darwin");
    expect(defaultHostEnv("linux").hostOs).toBe("linux");
  });
});

describe("hostToContainer in the server", () => {
  it("is the identity of path.resolve on Linux, with or without the OS given", () => {
    for (const p of LINUX_PATHS) {
      expect(hostToContainer(p)).toBe(path.resolve(p));
      expect(hostToContainer(p, "linux")).toBe(path.resolve(p));
      expect(hostToContainer(p, "darwin")).toBe(path.resolve(p));
    }
  });

  it("maps a Windows path under /mnt/host", () => {
    expect(hostToContainer("C:\\Users\\tester\\work\\app", "win32")).toBe(
      "/mnt/host/c/Users/tester/work/app",
    );
    expect(() => hostToContainer("\\\\server\\share", "win32")).toThrow(/UNC/);
  });

  it("makes bind sources and binds", () => {
    expect(bindSource("/home/tester/x/")).toBe("/home/tester/x");
    expect(bindSource("c:\\Users\\tester\\x\\", "win32")).toBe("C:/Users/tester/x");
    expect(mirrorBind("/home/tester/x")).toBe("/home/tester/x:/home/tester/x");
    expect(mirrorBind("C:/Users/tester/x", "win32")).toBe(
      "C:/Users/tester/x:/mnt/host/c/Users/tester/x",
    );
    expect(splitMountSpec("C:/a:/b:ro", "win32")).toEqual({
      host: "C:/a",
      container: "/b",
      options: "ro",
    });
  });

  it("tells the agent container paths in prompts", () => {
    expect(promptPath(linuxEnv, "/home/tester/work/app")).toBe("~/work/app");
    expect(promptPath(winEnv, infraFile("C:/Users/tester/work/app"))).toBe(
      "/mnt/host/c/Users/tester/work/app/.aio/INFRA.md",
    );
    expect(promptPath(winEnv, worktreeNotesDir("C:/Users/tester/work/app/.worktrees/fix"))).toBe(
      "/mnt/host/c/Users/tester/work/app/.worktrees/fix/.aio",
    );
  });
});

describe("transcript folders", () => {
  it("encode the container path", () => {
    expect(encodeProjectDir("/home/tester/work/app")).toBe("-home-tester-work-app");
    expect(encodeProjectDir("/home/tester/work/app", "linux")).toBe("-home-tester-work-app");
    expect(encodeProjectDir("C:\\Users\\tester\\work\\app", "win32")).toBe(
      "-mnt-host-c-Users-tester-work-app",
    );
    expect(encodeProjectDir("c:/Users/tester/work/app/", "win32")).toBe(
      "-mnt-host-c-Users-tester-work-app",
    );
  });

  it("are looked up under the store with the host OS of the environment", () => {
    const env: HostEnv = { ...winEnv, claudeProjectsRoot: () => "C:/store" };
    expect(projectDirFor(env, "C:/Users/tester/app")).toBe(
      path.join("C:/store", "-mnt-host-c-Users-tester-app"),
    );
    expect(transcriptPath(env, "C:/Users/tester/app", "u1")).toBe(
      path.join("C:/store", "-mnt-host-c-Users-tester-app", "u1.jsonl"),
    );
  });

  it("hash the container path when the name is too long", () => {
    const long = `C:/${"a".repeat(250)}`;
    const encoded = encodeProjectDir(long, "win32");
    expect(encoded.startsWith("-mnt-host-c-aaa")).toBe(true);
    expect(encoded.length).toBeGreaterThan(200);
    expect(encoded).not.toBe(encodeProjectDir(`/${"a".repeat(250)}`, "linux"));
  });
});

describe("project roots", () => {
  it("normalize as before on Linux", () => {
    expect(normalizeRoot("/home/tester/app/")).toBe("/home/tester/app");
    expect(normalizeRoot("/home/tester/app/", "linux")).toBe("/home/tester/app");
  });

  it("get the stored form on Windows", () => {
    expect(normalizeRoot(" c:\\Users\\tester\\App\\ ", "win32")).toBe("C:/Users/tester/App");
    expect(normalizeRoot("\\\\?\\C:\\Users\\tester\\App", "win32")).toBe("C:/Users/tester/App");
    expect(normalizeRoot("C:/Users/tester/App", "win32")).toBe("C:/Users/tester/App");
    expect(normalizeRoot("\\\\server\\share", "win32")).toBe("\\\\server\\share");
    expect(projectIdForRoot("C:/Users/tester/App")).toMatch(/^App-[0-9a-f]{8}$/);
    expect(projectIdForRoot("C:/Users/tester/App")).toBe(
      projectIdForRoot(normalizeRoot("c:\\Users\\tester\\App\\", "win32")),
    );
    expect(defaultProjectName("C:/Users/tester/App")).toBe("App");
  });
});

const T = "2026-10-28T09:00:00.000Z";
const box: Box = {
  id: "aio-agent-fix",
  projectId: "app-12345678",
  hostKey: "fix",
  targetDir: "C:/Users/tester/work",
  worktree: "C:/Users/tester/work/repo/.worktrees/fix",
  branch: "claude/fix",
  movedFrom: "C:/Users/tester/work/fix",
  sessionUuid: null,
  conversationName: "Fix it",
  transcriptSyncedName: "",
  platform: "claude",
  skipPermissions: false,
  container: "aio-agent-proj-app-12345678",
  session: "aio-agent-fix",
  wasRunning: false,
  sshRemoteRefs: [],
  createdAt: T,
  updatedAt: T,
};

describe("box arguments", () => {
  it("add the project root by its container path", () => {
    const args = baseClaudeArgs(
      box,
      { root: "C:/Users/tester/work", primaryRepo: "C:\\Users\\tester\\work\\repo\\" },
      "win32",
    );
    expect(args.slice(-2)).toEqual(["--add-dir", "/mnt/host/c/Users/tester/work"]);
    // The same repository spelled differently is the root itself: no --add-dir.
    expect(
      baseClaudeArgs(
        box,
        { root: "C:/Users/tester/work", primaryRepo: "c:\\Users\\tester\\work" },
        "win32",
      ),
    ).not.toContain("--add-dir");
  });

  it("name container paths in the moved message", () => {
    const text = movedMessage(winEnv, box);
    expect(text).toContain("/mnt/host/c/Users/tester/work/repo/.worktrees/fix ");
    expect(text).toContain("/mnt/host/c/Users/tester/work/fix.pre-worktree");
    expect(text).not.toContain("C:");
  });
});

const winInput: LaunchInput = {
  container: C,
  projectId: "app-1a2b3c4d",
  root: "C:/Users/tester/work/app",
  mounts: [
    { host: "D:\\data\\ref", container: "/mnt/host/d/data/ref" },
    { host: "D:/data/shared", container: "/shared" },
  ],
  globalMounts: [{ host: "E:\\archive", container: "/archive" }],
  tcpMaps: [],
  image: "aio-agent",
  engine: { hostPort: 41000, token: "secret-token-value-0123456789", version: "1.0.0" },
  secretNames: [],
};

describe("the launch spec on Windows", () => {
  const spec = buildLaunchSpec(winEnv, winInput, { projectsLinkMounts: [], hasGitconfig: true });

  it("mounts the root under /mnt/host and works there", () => {
    expect(spec.binds[0]).toBe("C:/Users/tester/work/app:/mnt/host/c/Users/tester/work/app");
    expect(spec.workingDir).toBe("/mnt/host/c/Users/tester/work/app");
    expect(spec.env).toContain(`${ENGINE_ENV.projectRoot}=/mnt/host/c/Users/tester/work/app`);
    expect(spec.env).toContain("GIT_CONFIG_GLOBAL=/mnt/host/c/Users/tester/work/app/gitconfig");
  });

  it("binds the home folders, mounts, state, and broker with Windows sources", () => {
    expect(spec.binds).toEqual([
      "C:/Users/tester/work/app:/mnt/host/c/Users/tester/work/app",
      "C:/Users/tester/.claude:/home/tester/.claude",
      "C:/Users/tester/.claude.json:/home/tester/.claude.json",
      "C:/Users/tester/.codex:/home/tester/.codex",
      "C:/Users/tester/.copilot:/home/tester/.copilot",
      `C:/Users/tester/.ai-orchestrator/sessions/${C}:/home/tester/.claude/sessions`,
      "D:/data/ref:/mnt/host/d/data/ref",
      "D:/data/shared:/shared",
      "E:/archive:/archive",
      `C:/Users/tester/.ai-orchestrator/state/${C}:/run/aio`,
      expect.stringMatching(
        /^C:\/Users\/tester\/\.ai-orchestrator\/broker\/[0-9a-f]{16}:\/run\/aio-broker:ro$/,
      ),
    ]);
  });

  it("gives docker run the same binds and working directory", () => {
    const args = toDockerRunArgs(spec);
    expect(args).toContain("C:/Users/tester/work/app:/mnt/host/c/Users/tester/work/app");
    expect(args[args.indexOf("-w") + 1]).toBe("/mnt/host/c/Users/tester/work/app");
  });

  it("maps the transcript store and other link targets in accounts mode", () => {
    const accounts = buildLaunchSpec(
      winEnv,
      {
        ...winInput,
        accounts: { claudeDirs: ["C:/Users/tester/.ai-orchestrator/accounts/claude/personal"] },
      },
      {
        projectsLinkMounts: [],
        hasGitconfig: false,
        accountLinkTargets: ["C:/Users/tester/.ai-orchestrator/transcripts/claude"],
      },
    );
    expect(accounts.binds).toContain(
      "C:/Users/tester/.ai-orchestrator/accounts:/mnt/host/c/Users/tester/.ai-orchestrator/accounts",
    );
    expect(accounts.binds).toContain(
      `C:/Users/tester/.ai-orchestrator/sessions/${C}:/mnt/host/c/Users/tester/.ai-orchestrator/accounts/claude/personal/sessions`,
    );
    expect(accounts.binds).toContain(
      "C:/Users/tester/.ai-orchestrator/transcripts/claude:/mnt/host/c/Users/tester/.ai-orchestrator/transcripts/claude",
    );
  });

  it("refuses a UNC root and a POSIX root", () => {
    expect(() =>
      buildLaunchSpec(
        winEnv,
        { ...winInput, root: "\\\\server\\share\\app" },
        { projectsLinkMounts: [], hasGitconfig: false },
      ),
    ).toThrow(/UNC/);
    expect(() =>
      buildLaunchSpec(
        winEnv,
        { ...winInput, root: "/home/tester/app" },
        { projectsLinkMounts: [], hasGitconfig: false },
      ),
    ).toThrow(/drive letter/);
  });

  it("lists the container paths the root setup step fixes", () => {
    expect(
      mountContainerPaths(winInput, "C:/Users/tester/.ai-orchestrator/accounts", "win32"),
    ).toEqual([
      "/mnt/host/c/Users/tester/work/app",
      "/mnt/host/d/data/ref",
      "/shared",
      "/archive",
      "/mnt/host/c/Users/tester/.ai-orchestrator/accounts",
    ]);
    expect(mountBind({ host: "d:\\x\\", container: "/x" }, "win32")).toBe("D:/x:/x");
  });
});

describe("the launch spec on macOS and Linux", () => {
  const input: LaunchInput = {
    ...winInput,
    root: "/Users/tester/work/app",
    mounts: [{ host: "/Users/tester/data", container: "/Users/tester/data" }],
    globalMounts: [],
  };

  it("is the same on macOS as on Linux", () => {
    const facts = { projectsLinkMounts: ["/Users/tester/store"], hasGitconfig: true };
    const env: HostEnv = { home: "/Users/tester", user: "tester", now: () => new Date() };
    const linux = buildLaunchSpec(env, input, facts);
    expect(buildLaunchSpec({ ...env, hostOs: "darwin" }, input, facts)).toEqual(linux);
    expect(buildLaunchSpec({ ...env, hostOs: "linux" }, input, facts)).toEqual(linux);
    expect(linux.workingDir).toBe("/Users/tester/work/app");
    expect(linux.binds).toContain("/Users/tester/work/app:/Users/tester/work/app");
    expect(linux.binds).toContain("/Users/tester/store:/Users/tester/store");
  });
});

describe("worktrees with relative paths", () => {
  it("link the worktree to the repository with relative paths", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const added = await addWorktree(repo, "fix", { relativePaths: true });
    expect(added.ok).toBe(true);
    const gitFile = fs.readFileSync(path.join(repo, ".worktrees", "fix", ".git"), "utf8");
    expect(gitFile.trim()).toBe("gitdir: ../../.git/worktrees/fix");
    const back = fs.readFileSync(path.join(repo, ".git", "worktrees", "fix", "gitdir"), "utf8");
    expect(path.isAbsolute(back.trim())).toBe(false);
  });

  it("keep absolute paths by default, as on Linux before", async () => {
    const repo = initRepo(path.join(tempDir(), "repo"));
    const added = await addWorktree(repo, "fix");
    expect(added.ok).toBe(true);
    const gitFile = fs.readFileSync(path.join(repo, ".worktrees", "fix", ".git"), "utf8");
    expect(gitFile.trim()).toBe(`gitdir: ${repo}/.git/worktrees/fix`);
  });
});

describe("the box view", () => {
  it("names the container working directory, the host path on Linux", async () => {
    const h = makeHarness();
    const dir = h.dir("work", "app");
    const box = await h.core.boxes.create({ targetDir: dir, layout: "root", start: false });
    expect(h.core.boxes.view(box).containerWorkDir).toBe(dir);
    expect(h.core.boxes.containerWorkDir(box)).toBe(dir);
  });
});
