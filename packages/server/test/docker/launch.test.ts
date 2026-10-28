// Golden tests for the launch spec against inventory sections 4.1 and 4.2.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchSpec,
  mergeMounts,
  prepareLaunchHost,
  projectsSymlinkTarget,
  tcpMapsLabel,
  toDockerRunArgs,
  type LaunchInput,
} from "../../src/docker/launch.js";
import { KEEPER_SCRIPT } from "../../src/docker/scripts.js";
import type { HostEnv } from "../../src/records/env.js";

const env: HostEnv = { home: "/home/tester", user: "tester", now: () => new Date() };
const C = "claude-agent-proj-app-1a2b3c4d";

const input: LaunchInput = {
  container: C,
  projectId: "app-1a2b3c4d",
  root: "/home/tester/work/app",
  mounts: [
    { host: "/data/ref", container: "/data/ref" },
    { host: "/data/shared", container: "/shared" },
  ],
  globalMounts: [
    { host: "/home/tester/Bin/.project_archive", container: "/home/tester/Bin/.project_archive" },
    { host: "/elsewhere", container: "/shared/" },
  ],
  tcpMaps: [{ host: 8080, container: 3000 }],
  image: "claude-code",
  engine: { hostPort: 41000, token: "secret-token-value-0123456789", version: "4.0.0" },
  extraEnv: { GITHUB_TOKEN: "ghp_value", API_KEY: "k" },
};

describe("buildLaunchSpec", () => {
  it("matches the inventoried 3.3.5 launch, minus the pool, plus the engine", () => {
    const spec = buildLaunchSpec(env, input, {
      projectsSymlinkTarget: "/home/tester/.claude-projects-shared",
      hasGitconfig: true,
    });
    expect(spec).toEqual({
      name: C,
      image: "claude-code",
      user: "tester",
      workingDir: "/home/tester/work/app",
      cmd: [
        "bash",
        "-c",
        `git config --global --add safe.directory '*' 2>/dev/null; ${KEEPER_SCRIPT}`,
        "_",
        "/run/claude-box",
        "30",
      ],
      env: [
        "IS_SANDBOX=1",
        "DISABLE_AUTOUPDATER=1",
        "GIT_CONFIG_GLOBAL=/home/tester/work/app/gitconfig",
        "AGENTBOX_ENGINE_TOKEN=secret-token-value-0123456789",
        "AGENTBOX_ENGINE_PORT=20411",
        "AGENTBOX_PROJECT_ROOT=/home/tester/work/app",
        `AGENTBOX_CONTAINER=${C}`,
        "AGENTBOX_ENGINE_VERSION=4.0.0",
        "API_KEY=k",
        "GITHUB_TOKEN=ghp_value",
      ],
      binds: [
        "/home/tester/work/app:/home/tester/work/app",
        "/home/tester/.claude:/home/tester/.claude",
        "/home/tester/.claude.json:/home/tester/.claude.json",
        "/home/tester/.codex:/home/tester/.codex",
        "/home/tester/.copilot:/home/tester/.copilot",
        "/home/tester/.claude-projects-shared:/home/tester/.claude-projects-shared",
        `/home/tester/.claude-box/sessions/${C}:/home/tester/.claude/sessions`,
        "/data/ref:/data/ref",
        "/data/shared:/shared",
        "/home/tester/Bin/.project_archive:/home/tester/Bin/.project_archive",
        `/home/tester/.claude-box/state/${C}:/run/claude-box`,
      ],
      portBindings: {
        "20411/tcp": [{ hostIp: "127.0.0.1", hostPort: "41000" }],
        "3000/tcp": [{ hostIp: "", hostPort: "8080" }],
      },
      labels: {
        "agentbox.project": "app-1a2b3c4d",
        "agentbox.tcp-maps": "8080:3000",
        "agentbox.secret-names": "API_KEY,GITHUB_TOKEN",
        "agentbox.engine-version": "4.0.0",
      },
      tty: true,
      openStdin: true,
      autoRemove: true,
    });
  });

  it("omits GIT_CONFIG_GLOBAL and the symlink bind when absent", () => {
    const spec = buildLaunchSpec(
      env,
      { ...input, extraEnv: {}, tcpMaps: [] },
      { projectsSymlinkTarget: null, hasGitconfig: false },
    );
    expect(spec.env.some((e) => e.startsWith("GIT_CONFIG_GLOBAL="))).toBe(false);
    expect(spec.binds).toHaveLength(10);
    expect(Object.keys(spec.portBindings)).toEqual(["20411/tcp"]);
    expect(spec.labels["agentbox.secret-names"]).toBe("");
  });

  it("prints a docker run line with secrets masked", () => {
    const spec = buildLaunchSpec(env, input, { projectsSymlinkTarget: null, hasGitconfig: false });
    const args = toDockerRunArgs(spec);
    expect(args.slice(0, 11)).toEqual([
      "run",
      "-d",
      "-i",
      "-t",
      "--rm",
      "--name",
      C,
      "--user",
      "tester",
      "-e",
      "IS_SANDBOX=1",
    ]);
    expect(args).toContain("AGENTBOX_ENGINE_TOKEN=***");
    expect(args).toContain("GITHUB_TOKEN=***");
    expect(args.join(" ")).not.toContain("ghp_value");
    expect(args).toContain("127.0.0.1:41000:20411");
    expect(args).toContain("8080:3000");
    expect(args.indexOf("claude-code")).toBe(args.length - 7);
  });
});

describe("mergeMounts", () => {
  it("drops a global mount whose container path the project uses", () => {
    expect(
      mergeMounts(
        [{ host: "/a", container: "/x/" }],
        [
          { host: "/b", container: "/x" },
          { host: "/c", container: "/y" },
        ],
      ),
    ).toEqual([
      { host: "/a", container: "/x/" },
      { host: "/c", container: "/y" },
    ]);
  });

  it("formats TCP map labels sorted", () => {
    expect(
      tcpMapsLabel([
        { host: 9000, container: 3000 },
        { host: 8080, container: 80 },
      ]),
    ).toBe("8080:80,9000:3000");
  });
});

describe("host preparation", () => {
  it("creates the host directories, empties the sessions dir, and finds the symlink target", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-launch-"));
    const e = { ...env, home };
    const root = path.join(home, "work");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "gitconfig"), "[safe]\n\tdirectory = *\n");
    const sessions = path.join(home, ".claude-box", "sessions", C);
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "11.json"), "{}");
    const shared = path.join(home, "shared-projects");
    fs.mkdirSync(shared);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.symlinkSync(shared, path.join(home, ".claude", "projects"));

    const facts = prepareLaunchHost(e, { container: C, root });
    expect(facts).toEqual({ projectsSymlinkTarget: shared, hasGitconfig: true });
    for (const d of [".claude/sessions", ".codex", ".copilot"])
      expect(fs.statSync(path.join(home, d)).isDirectory()).toBe(true);
    expect(fs.readdirSync(sessions)).toEqual([]);
    expect(fs.existsSync(path.join(home, ".claude-box", "state", C))).toBe(true);
  });

  it("ignores a projects symlink that points inside ~/.claude", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-launch-"));
    fs.mkdirSync(path.join(home, ".claude", "real"), { recursive: true });
    fs.symlinkSync(path.join(home, ".claude", "real"), path.join(home, ".claude", "projects"));
    expect(projectsSymlinkTarget({ ...env, home })).toBeNull();
    fs.rmSync(path.join(home, ".claude", "projects"));
    fs.mkdirSync(path.join(home, ".claude", "projects"));
    expect(projectsSymlinkTarget({ ...env, home })).toBeNull();
  });
});
