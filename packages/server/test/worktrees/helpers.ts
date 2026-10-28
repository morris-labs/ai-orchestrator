// Helpers that build real git repositories in temporary directories.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Box } from "@agentbox/contracts";
import type { HostEnv } from "../../src/records/env.js";

// Keep the developer's own git configuration out of the tests.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export function tempDir(prefix = "agentbox-wt-"): string {
  // realpath: git reports resolved paths, and /tmp can be a symlink.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function sh(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configure(dir: string): void {
  sh(dir, "config", "user.name", "Test User");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "commit.gpgsign", "false");
}

export function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function commitAll(dir: string, message: string): void {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
}

/** A repository with one commit on `main`. */
export function initRepo(dir: string, origin?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  configure(dir);
  write(path.join(dir, "README.md"), "hello\n");
  commitAll(dir, "Initial commit");
  if (origin !== undefined) sh(dir, "remote", "add", "origin", origin);
  return dir;
}

/** A bare origin, a project checkout of it, and a helper to clone it again. */
export function originAndProject(root: string): { origin: string; project: string } {
  const seed = initRepo(path.join(root, "seed"));
  const origin = path.join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  const project = path.join(root, "project");
  execFileSync("git", ["clone", "-q", origin, project]);
  configure(project);
  return { origin, project };
}

export function cloneInto(origin: string, dir: string): string {
  execFileSync("git", ["clone", "-q", origin, dir]);
  configure(dir);
  return dir;
}

export function testEnv(home: string): HostEnv {
  return { home, user: "tester", now: () => new Date(2026, 9, 28, 9, 30, 15) };
}

export function makeBox(overrides: Partial<Box>): Box {
  return {
    id: "claude-agent-fix_login",
    projectId: "project-0123abcd",
    hostKey: "fix-login",
    targetDir: "/nowhere",
    sessionUuid: null,
    conversationName: "fix_login",
    transcriptSyncedName: "fix_login",
    platform: "claude",
    skipPermissions: true,
    container: "claude-agent-proj-project-0123abcd",
    session: "claude-agent-fix_login",
    wasRunning: false,
    sshRemoteRefs: [],
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
    ...overrides,
  };
}
