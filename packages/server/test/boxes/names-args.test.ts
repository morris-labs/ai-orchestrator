import { describe, expect, it } from "vitest";
import type { Box } from "@aio/contracts";
import {
  baseClaudeArgs,
  movedMessage,
  nameArg,
  platformArgs,
  sideSessionArgs,
} from "../../src/boxes/args.js";
import { sanitizeBoxBase, slugifyIssueName, uniqueBoxName } from "../../src/boxes/names.js";

const T = "2026-10-28T09:00:00.000Z";
const box: Box = {
  id: "aio-agent-fix",
  projectId: "app-12345678",
  hostKey: "fix",
  targetDir: "/home/tester/app",
  sessionUuid: null,
  conversationName: "Fix it",
  transcriptSyncedName: "",
  platform: "claude",
  skipPermissions: true,
  container: "aio-agent-proj-app-12345678",
  session: "aio-agent-fix",
  wasRunning: false,
  sshRemoteRefs: [],
  createdAt: T,
  updatedAt: T,
};
const project = { root: "/home/tester/app", primaryRepo: "/home/tester/app" };

describe("sanitizers", () => {
  it("match the bash tr pipelines byte for byte", () => {
    expect(sanitizeBoxBase("My App.v2_x")).toBe("my-app.v2_x");
    expect(sanitizeBoxBase("Émile café")).toBe("-mile-caf-");
    expect(sanitizeBoxBase("a😀b")).toBe("a--b");
    expect(slugifyIssueName("Emails not sending!")).toBe("Emails_not_sending");
    expect(slugifyIssueName("  --Fix: the  bug--  ")).toBe("Fix_the_bug");
    expect(slugifyIssueName("café au lait")).toBe("caf_au_lait");
    expect(slugifyIssueName("!!!")).toBe("");
  });

  it("finds a unique name against containers, records, and tmux forms", () => {
    expect(uniqueBoxName("app", new Set())).toBe("aio-agent-app");
    expect(uniqueBoxName("app", new Set(["aio-agent-app"]))).toBe("aio-agent-app-2");
    expect(uniqueBoxName("app", new Set(["aio-agent-app", "aio-agent-app-2"]))).toBe(
      "aio-agent-app-3",
    );
    expect(uniqueBoxName("app.example.com", new Set(["aio-agent-app_example_com"]))).toBe(
      "aio-agent-app.example.com-2",
    );
  });
});

describe("claude arguments", () => {
  it("builds the base flags like 3.3.5", () => {
    expect(baseClaudeArgs(box, project)).toEqual([
      "--remote-control=Fix it",
      "--permission-mode",
      "auto",
      "--allow-dangerously-skip-permissions",
    ]);
    expect(
      baseClaudeArgs(
        { ...box, conversationName: "", skipPermissions: false, model: "opus", effort: "max" },
        project,
      ),
    ).toEqual([
      "--remote-control",
      "--permission-mode",
      "auto",
      "--model",
      "opus",
      "--effort",
      "max",
    ]);
  });

  it("keeps a name that starts with a dash a value, not a flag", () => {
    const args = baseClaudeArgs(
      { ...box, conversationName: "--dangerously-skip-permissions" },
      project,
    );
    expect(args[0]).toBe("--remote-control=--dangerously-skip-permissions");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(nameArg("-p")).toBe("--name=-p");
  });

  it("adds the project root for every worktree box", () => {
    const wt = { ...box, worktree: "/home/tester/app/repo/.worktrees/fix" };
    expect(baseClaudeArgs(box, project)).not.toContain("--add-dir");
    expect(baseClaudeArgs(wt, project)).toEqual(
      expect.arrayContaining(["--add-dir", "/home/tester/app"]),
    );
    expect(
      baseClaudeArgs(wt, { root: "/home/tester/app", primaryRepo: "/home/tester/app/repo/" }),
    ).toEqual(expect.arrayContaining(["--add-dir", "/home/tester/app"]));
  });

  it("builds Codex and Copilot flags and side sessions", () => {
    expect(platformArgs(box, project, "codex", false, "hi")).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--",
      "hi",
    ]);
    // A prompt that looks like a flag or a subcommand stays the prompt.
    expect(platformArgs(box, project, "codex", false, "-x fix it").slice(-2)).toEqual([
      "--",
      "-x fix it",
    ]);
    expect(
      platformArgs({ ...box, skipPermissions: false }, project, "codex", false, "resume"),
    ).toEqual(["--", "resume"]);
    expect(platformArgs({ ...box, skipPermissions: false }, project, "codex", true, "hi")).toEqual([
      "resume",
      "--last",
    ]);
    expect(platformArgs(box, project, "copilot", false, "hi")).toEqual([
      "--remote",
      "--allow-all-tools",
      "-i",
      "hi",
    ]);
    expect(platformArgs(box, project, "copilot", true, "")).toEqual([
      "--remote",
      "--continue",
      "--allow-all-tools",
    ]);
    expect(platformArgs(box, project, "claude", false, "x")).toEqual(baseClaudeArgs(box, project));
    expect(sideSessionArgs(box, project, "codex")).toEqual(["remote-control", "--no-daemon"]);
    expect(sideSessionArgs(box, project, "copilot")).toEqual(["--remote", "--allow-all-tools"]);
  });

  it("writes the moved message with prompt paths", () => {
    const env = { home: "/home/tester", user: "tester", now: () => new Date() };
    const msg = movedMessage(env, {
      ...box,
      worktree: "/home/tester/app/.worktrees/Fix_it",
      branch: "claude/Fix_it",
      movedFrom: "/home/tester/app/Fix_it",
    });
    expect(msg).toBe(
      "This conversation was moved into a git worktree. Your working directory is now ~/app/.worktrees/Fix_it (branch claude/Fix_it). " +
        "The folder you used before, ~/app/Fix_it, was renamed to ~/app/Fix_it.pre-worktree and must not be used any more. " +
        "Your PLAN.md and STATUS.md are now in ~/app/.worktrees/Fix_it/.aio, and the shared INFRA.md is ~/app/.aio/INFRA.md. " +
        "Read them there, keep updating them there, and use these paths in place of any earlier ones from this conversation. " +
        "Reply with one line to confirm, then carry on.",
    );
  });
});
