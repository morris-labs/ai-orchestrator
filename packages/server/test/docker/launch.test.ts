// Golden tests for the launch spec against inventory sections 4.1 and 4.2.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchSpec,
  mergeMounts,
  mountContainerPaths,
  prepareLaunchHost,
  projectsLinkMounts,
  tcpMapsLabel,
  toDockerRunArgs,
  type LaunchInput,
} from "../../src/docker/launch.js";
import { GIT_SAFE_DIRECTORY_SETUP, KEEPER_PATH } from "../../src/docker/scripts.js";
import { brokerDirName, type HostEnv } from "../../src/records/env.js";
import { tempDir } from "../tmp.js";

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
  secretNames: ["GITHUB_TOKEN", "API_KEY"],
};

describe("buildLaunchSpec", () => {
  it("puts no secret in the environment and leaves reserved names out of the label", () => {
    const spec = buildLaunchSpec(
      env,
      { ...input, secretNames: ["AGENTBOX_ENGINE_TOKEN", "AGENTBOX_BROKER_SOCKET", "API_KEY"] },
      { projectsLinkMounts: [], hasGitconfig: false },
    );
    expect(spec.env.filter((e) => e.startsWith("AGENTBOX_ENGINE_TOKEN="))).toEqual([]);
    expect(spec.env.some((e) => e.startsWith("API_KEY"))).toBe(false);
    expect(spec.env.filter((e) => e.startsWith("AGENTBOX_BROKER_SOCKET="))).toEqual([
      "AGENTBOX_BROKER_SOCKET=/run/agentbox-broker/broker.sock",
    ]);
    expect(spec.labels["agentbox.secret-names"]).toBe("API_KEY");
    expect(spec.labels["agentbox.secrets"]).toBe("broker");
  });

  it("adds a host test script's plain variables, never over a reserved one", () => {
    const spec = buildLaunchSpec(
      env,
      {
        ...input,
        extraEnv: { AGENTBOX_MOCK_VENDORS: "1", AGENTBOX_ENGINE_TOKEN_FILE: "/tmp/evil" },
      },
      { projectsLinkMounts: [], hasGitconfig: false },
    );
    expect(spec.env).toContain("AGENTBOX_MOCK_VENDORS=1");
    expect(spec.env.filter((e) => e.startsWith("AGENTBOX_ENGINE_TOKEN_FILE="))).toEqual([
      "AGENTBOX_ENGINE_TOKEN_FILE=/run/claude-box/engine.token",
    ]);
  });

  it("mounts the broker directory read-only, and prepares it on the host", () => {
    const home = tempDir("agentbox-launch-");
    const hostEnv: HostEnv = { home, user: "tester", now: () => new Date() };
    prepareLaunchHost(hostEnv, { container: C, root: path.join(home, "app") });
    const dir = path.join(home, ".claude-box", "broker", brokerDirName(C));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const spec = buildLaunchSpec(hostEnv, input, {
      projectsLinkMounts: [],
      hasGitconfig: false,
    });
    expect(spec.binds).toContain(`${dir}:/run/agentbox-broker:ro`);
  });

  it("labels whether the container's sudo asks for a password, and lists the mount paths", () => {
    const facts = { projectsLinkMounts: [], hasGitconfig: false };
    expect(buildLaunchSpec(env, input, facts).labels["agentbox.sudo"]).toBe("off");
    const on = buildLaunchSpec(env, { ...input, sudoPassword: true }, facts);
    expect(on.labels["agentbox.sudo"]).toBe("password");
    // Neither the keeper command nor the environment carries anything about sudo.
    expect(on.cmd.join(" ")).not.toContain("sudo");
    expect(on.env.join(" ")).not.toContain("sudo");
    expect(mountContainerPaths(input)).toEqual([
      "/home/tester/work/app",
      "/data/ref",
      "/shared",
      "/home/tester/Bin/.project_archive",
    ]);
  });

  it("keeps the engine token out of the container's environment", () => {
    const spec = buildLaunchSpec(env, input, { projectsLinkMounts: [], hasGitconfig: false });
    expect(spec.env.join("\n")).not.toContain(input.engine.token);
  });

  // The golden spec is the 3.3.5 launch minus the port pool, plus the engine.
  // It differs from 3.3.5 in the command and one variable on purpose: the
  // container runs the image's keeper.sh (which also keeps the engine
  // running) in place of the inline 3.3.5 keeper, and gets
  // AGENTBOX_STATE_DIR, where keeper.sh and the engine share state. The
  // engine token is a file in that directory, not a variable.
  it("matches the inventoried 3.3.5 launch, minus the pool, plus the engine", () => {
    const spec = buildLaunchSpec(env, input, {
      projectsLinkMounts: ["/home/tester/.claude-box/transcripts/claude"],
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
        `${GIT_SAFE_DIRECTORY_SETUP}; exec ${KEEPER_PATH} "$1" "$2"`,
        "_",
        "/run/claude-box",
        "30",
      ],
      env: [
        "IS_SANDBOX=1",
        "DISABLE_AUTOUPDATER=1",
        "GIT_CONFIG_GLOBAL=/home/tester/work/app/gitconfig",
        "AGENTBOX_ENGINE_TOKEN_FILE=/run/claude-box/engine.token",
        "AGENTBOX_ENGINE_PORT=20411",
        "AGENTBOX_PROJECT_ROOT=/home/tester/work/app",
        `AGENTBOX_CONTAINER=${C}`,
        "AGENTBOX_ENGINE_VERSION=4.0.0",
        "AGENTBOX_STATE_DIR=/run/claude-box",
        "AGENTBOX_BROKER_SOCKET=/run/agentbox-broker/broker.sock",
      ],
      binds: [
        "/home/tester/work/app:/home/tester/work/app",
        "/home/tester/.claude:/home/tester/.claude",
        "/home/tester/.claude.json:/home/tester/.claude.json",
        "/home/tester/.codex:/home/tester/.codex",
        "/home/tester/.copilot:/home/tester/.copilot",
        "/home/tester/.claude-box/transcripts/claude:/home/tester/.claude-box/transcripts/claude",
        `/home/tester/.claude-box/sessions/${C}:/home/tester/.claude/sessions`,
        "/data/ref:/data/ref",
        "/data/shared:/shared",
        "/home/tester/Bin/.project_archive:/home/tester/Bin/.project_archive",
        `/home/tester/.claude-box/state/${C}:/run/claude-box`,
        `/home/tester/.claude-box/broker/${brokerDirName(C)}:/run/agentbox-broker:ro`,
      ],
      portBindings: {
        "20411/tcp": [{ hostIp: "127.0.0.1", hostPort: "41000" }],
        "3000/tcp": [{ hostIp: "127.0.0.1", hostPort: "8080" }],
      },
      labels: {
        "agentbox.project": "app-1a2b3c4d",
        "agentbox.tcp-maps": "127.0.0.1:8080:3000",
        "agentbox.secret-names": "API_KEY,GITHUB_TOKEN",
        "agentbox.engine-version": "4.0.0",
        "agentbox.sudo": "off",
        "agentbox.secrets": "broker",
      },
      capDrop: ["MKNOD", "SETFCAP"],
      tty: true,
      openStdin: true,
      autoRemove: true,
    });
  });

  it("omits GIT_CONFIG_GLOBAL and the symlink bind when absent", () => {
    const spec = buildLaunchSpec(
      env,
      { ...input, secretNames: [], tcpMaps: [] },
      { projectsLinkMounts: [], hasGitconfig: false },
    );
    expect(spec.env.some((e) => e.startsWith("GIT_CONFIG_GLOBAL="))).toBe(false);
    expect(spec.binds).toHaveLength(11);
    expect(Object.keys(spec.portBindings)).toEqual(["20411/tcp"]);
    expect(spec.labels["agentbox.secret-names"]).toBe("");
  });

  it("publishes TCP maps on loopback unless a map asks for every interface", () => {
    const spec = buildLaunchSpec(
      env,
      {
        ...input,
        tcpMaps: [
          { host: 8080, container: 3000 },
          { host: 9090, container: 4000, allInterfaces: true },
        ],
      },
      { projectsLinkMounts: [], hasGitconfig: false },
    );
    expect(spec.portBindings["3000/tcp"]).toEqual([{ hostIp: "127.0.0.1", hostPort: "8080" }]);
    expect(spec.portBindings["4000/tcp"]).toEqual([{ hostIp: "", hostPort: "9090" }]);
    expect(spec.labels["agentbox.tcp-maps"]).toBe("127.0.0.1:8080:3000,9090:4000");
    expect(toDockerRunArgs(spec)).toContain("9090:4000");
  });

  it("refuses a relative root or a mount docker can't bind", () => {
    const facts = { projectsLinkMounts: [], hasGitconfig: false };
    expect(() => buildLaunchSpec(env, { ...input, root: "work/app" }, facts)).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
    for (const bad of [
      { host: "data/ref", container: "/data/ref" },
      { host: "/data/ref", container: "relative" },
      { host: "/data/a:b", container: "/x" },
      { host: "/data/ref", container: "/x:ro" },
      { host: "/data/ref", container: "/" },
    ]) {
      expect(() => buildLaunchSpec(env, { ...input, mounts: [bad] }, facts)).toThrow(
        expect.objectContaining({ code: "validation" }),
      );
    }
  });

  it("prints a docker run line with secrets masked", () => {
    const built = buildLaunchSpec(env, input, { projectsLinkMounts: [], hasGitconfig: false });
    // A spec carries no secret value, but a masked line stays safe if one ever does.
    const spec = { ...built, env: [...built.env, "GITHUB_TOKEN=ghp_value"] };
    const args = toDockerRunArgs(spec);
    expect(args.slice(0, 15)).toEqual([
      "run",
      "-d",
      "-i",
      "-t",
      "--rm",
      "--name",
      C,
      "--user",
      "tester",
      "--cap-drop",
      "MKNOD",
      "--cap-drop",
      "SETFCAP",
      "-e",
      "IS_SANDBOX=1",
    ]);
    expect(args).toContain("AGENTBOX_ENGINE_TOKEN_FILE=/run/claude-box/engine.token");
    expect(args.join(" ")).not.toContain(input.engine.token);
    expect(args).toContain("GITHUB_TOKEN=***");
    expect(args).toContain("AGENTBOX_BROKER_SOCKET=/run/agentbox-broker/broker.sock");
    expect(args).toContain(
      `/home/tester/.claude-box/broker/${brokerDirName(C)}:/run/agentbox-broker:ro`,
    );
    expect(args.join(" ")).not.toContain("ghp_value");
    expect(args).toContain("127.0.0.1:41000:20411");
    expect(args).toContain("127.0.0.1:8080:3000");
    expect(args.indexOf("claude-code")).toBe(args.length - 1 - spec.cmd.length);
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
    ).toBe("127.0.0.1:8080:80,127.0.0.1:9000:3000");
  });
});

describe("host preparation", () => {
  it("creates the host directories, empties the sessions dir, and finds the link mounts", () => {
    const home = tempDir("agentbox-launch-");
    const e = { ...env, home };
    const root = path.join(home, "work");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "gitconfig"), "[safe]\n\tdirectory = *\n");
    const sessions = path.join(home, ".claude-box", "sessions", C);
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "11.json"), "{}");
    const shared = path.join(home, ".claude-box", "transcripts", "claude");
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.symlinkSync(shared, path.join(home, ".claude", "projects"));

    const facts = prepareLaunchHost(e, { container: C, root });
    expect(facts).toEqual({ projectsLinkMounts: [shared], hasGitconfig: true });
    for (const d of [".claude/sessions", ".codex", ".copilot"])
      expect(fs.statSync(path.join(home, d)).isDirectory()).toBe(true);
    expect(fs.readdirSync(sessions)).toEqual([]);
    expect(fs.existsSync(path.join(home, ".claude-box", "state", C))).toBe(true);
    // Docker would otherwise create a missing ~/.claude.json as a root-owned directory.
    const claudeJson = path.join(home, ".claude.json");
    expect(fs.lstatSync(claudeJson).isFile()).toBe(true);
    expect(fs.statSync(claudeJson).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(claudeJson, "utf8")).toBe("{}\n");
  });

  it("leaves an existing ~/.claude.json alone", () => {
    const home = tempDir("agentbox-launch-");
    const root = path.join(home, "work");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(home, ".claude.json"), '{"SYNTHETIC":1}');
    prepareLaunchHost({ ...env, home }, { container: C, root });
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe('{"SYNTHETIC":1}');
  });

  it("ignores a projects symlink that points inside ~/.claude", () => {
    const home = tempDir("agentbox-launch-");
    fs.mkdirSync(path.join(home, ".claude", "real"), { recursive: true });
    fs.symlinkSync(path.join(home, ".claude", "real"), path.join(home, ".claude", "projects"));
    expect(projectsLinkMounts({ ...env, home })).toEqual([]);
    fs.rmSync(path.join(home, ".claude", "projects"));
    fs.mkdirSync(path.join(home, ".claude", "projects"));
    expect(projectsLinkMounts({ ...env, home })).toEqual([]);
  });

  describe("projects link chains", () => {
    function chainHome(): { home: string; store: string; shared: string } {
      const home = fs.realpathSync(tempDir("agentbox-launch-"));
      const store = path.join(home, ".claude-box", "transcripts", "claude");
      fs.mkdirSync(store, { recursive: true });
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      return { home, store, shared: path.join(home, "intermediate-link") };
    }

    it("follows a chain: projects -> intermediate link -> store", () => {
      const { home, store, shared } = chainHome();
      fs.symlinkSync(store, shared);
      fs.symlinkSync(shared, path.join(home, ".claude", "projects"));
      // The link path binds at its own path (docker follows it to the store),
      // and the store binds at its own path, so the chain resolves inside.
      expect(projectsLinkMounts({ ...env, home })).toEqual([shared, store]);
    });

    it("follows a relative link in the chain", () => {
      const { home, store, shared } = chainHome();
      fs.symlinkSync(path.relative(home, store), shared);
      fs.symlinkSync("../intermediate-link", path.join(home, ".claude", "projects"));
      expect(projectsLinkMounts({ ...env, home })).toEqual([shared, store]);
    });

    it("mounts the store once for the final direct link", () => {
      const { home, store } = chainHome();
      fs.symlinkSync(store, path.join(home, ".claude", "projects"));
      expect(projectsLinkMounts({ ...env, home })).toEqual([store]);
    });

    it("mounts nothing for a dangling link", () => {
      const { home, store } = chainHome();
      fs.rmSync(store, { recursive: true });
      fs.symlinkSync(store, path.join(home, ".claude", "projects"));
      expect(projectsLinkMounts({ ...env, home })).toEqual([]);
    });

    it("turns the chain into binds in the launch spec", () => {
      const { home, store, shared } = chainHome();
      const spec = buildLaunchSpec({ ...env, home }, input, {
        projectsLinkMounts: [shared, store],
        hasGitconfig: false,
      });
      expect(spec.binds).toEqual(
        expect.arrayContaining([`${shared}:${shared}`, `${store}:${store}`]),
      );
    });
  });
});
