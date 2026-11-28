// Golden tests for the launch spec against inventory sections 4.1 and 4.2.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchSpec,
  mergeMounts,
  mountContainerPaths,
  prepareLaunchHost,
  linkTargetsOutside,
  tcpMapsLabel,
  toDockerRunArgs,
  type LaunchInput,
} from "../../src/docker/launch.js";
import { GIT_SAFE_DIRECTORY_SETUP, KEEPER_PATH } from "../../src/docker/scripts.js";
import { brokerDirName, type HostEnv } from "../../src/records/env.js";
import { tempDir } from "../tmp.js";

const env: HostEnv = { home: "/home/tester", user: "tester", now: () => new Date() };
const C = "aio-agent-proj-app-1a2b3c4d";

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
  image: "aio-agent",
  engine: { hostPort: 41000, token: "secret-token-value-0123456789", version: "1.0.0" },
  secretNames: ["GITHUB_TOKEN", "API_KEY"],
  accounts: { claudeDirs: ["/home/tester/.ai-orchestrator/accounts/claude/fixture"] },
};

describe("buildLaunchSpec", () => {
  it("puts no secret in the environment and leaves reserved names out of the label", () => {
    const spec = buildLaunchSpec(
      env,
      { ...input, secretNames: ["AIO_ENGINE_TOKEN", "AIO_BROKER_SOCKET", "API_KEY"] },
      { accountLinkTargets: [], hasGitconfig: false },
    );
    expect(spec.env.filter((e) => e.startsWith("AIO_ENGINE_TOKEN="))).toEqual([]);
    expect(spec.env.some((e) => e.startsWith("API_KEY"))).toBe(false);
    expect(spec.env.filter((e) => e.startsWith("AIO_BROKER_SOCKET="))).toEqual([
      "AIO_BROKER_SOCKET=/run/aio-broker/broker.sock",
    ]);
    expect(spec.labels["aio.secret-names"]).toBe("API_KEY");
    expect(spec.labels["aio.secrets"]).toBe("broker");
  });

  it("adds a host test script's plain variables, never over a reserved one", () => {
    const spec = buildLaunchSpec(
      env,
      {
        ...input,
        extraEnv: { AIO_MOCK_VENDORS: "1", AIO_ENGINE_TOKEN_FILE: "/tmp/evil" },
      },
      { accountLinkTargets: [], hasGitconfig: false },
    );
    expect(spec.env).toContain("AIO_MOCK_VENDORS=1");
    expect(spec.env.filter((e) => e.startsWith("AIO_ENGINE_TOKEN_FILE="))).toEqual([
      "AIO_ENGINE_TOKEN_FILE=/run/aio/engine.token",
    ]);
  });

  it("mounts the broker directory read-only, and prepares it on the host", () => {
    const home = tempDir("aio-launch-");
    const hostEnv: HostEnv = { home, user: "tester", now: () => new Date() };
    prepareLaunchHost(hostEnv, { container: C, root: path.join(home, "app") });
    const dir = path.join(home, ".ai-orchestrator", "broker", brokerDirName(C));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const spec = buildLaunchSpec(hostEnv, input, {
      accountLinkTargets: [],
      hasGitconfig: false,
    });
    expect(spec.binds).toContain(`${dir}:/run/aio-broker:ro`);
  });

  it("labels whether the container's sudo asks for a password, and lists the mount paths", () => {
    const facts = { accountLinkTargets: [], hasGitconfig: false };
    expect(buildLaunchSpec(env, input, facts).labels["aio.sudo"]).toBe("off");
    const on = buildLaunchSpec(env, { ...input, sudoPassword: true }, facts);
    expect(on.labels["aio.sudo"]).toBe("password");
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

  it("keeps the pnpm store out of the checkout, on the project's own mount", () => {
    // The project root is its own mount, so pnpm would otherwise put its
    // store at the mount's root: the main checkout.
    const spec = buildLaunchSpec(env, input, { accountLinkTargets: [], hasGitconfig: false });
    expect(spec.env).toContain("npm_config_store_dir=/home/tester/work/app/.aio/pnpm-store");
    expect(spec.env).toContain("pnpm_config_store_dir=/home/tester/work/app/.aio/pnpm-store");
  });

  it("keeps the engine token out of the container's environment", () => {
    const spec = buildLaunchSpec(env, input, { accountLinkTargets: [], hasGitconfig: false });
    expect(spec.env.join("\n")).not.toContain(input.engine.token);
  });

  // The golden spec is the 3.3.5 launch minus the port pool, plus the engine.
  // It differs from 3.3.5 in the command and some variables on purpose: the
  // container runs the image's keeper.sh (which also keeps the engine
  // running) in place of the inline 3.3.5 keeper, and gets
  // AIO_STATE_DIR, where keeper.sh and the engine share state. The
  // engine token is a file in that directory, not a variable. It also
  // sets the pnpm store folder.
  it("matches the inventoried 3.3.5 launch, minus the pool, plus the engine", () => {
    const spec = buildLaunchSpec(env, input, {
      accountLinkTargets: ["/home/tester/.ai-orchestrator/transcripts/claude"],
      hasGitconfig: true,
    });
    expect(spec).toEqual({
      name: C,
      image: "aio-agent",
      user: "tester",
      workingDir: "/home/tester/work/app",
      cmd: [
        "bash",
        "-c",
        `${GIT_SAFE_DIRECTORY_SETUP}; exec ${KEEPER_PATH} "$1" "$2"`,
        "_",
        "/run/aio",
        "30",
      ],
      env: [
        "IS_SANDBOX=1",
        "DISABLE_AUTOUPDATER=1",
        "GIT_CONFIG_GLOBAL=/home/tester/work/app/gitconfig",
        "npm_config_store_dir=/home/tester/work/app/.aio/pnpm-store",
        "pnpm_config_store_dir=/home/tester/work/app/.aio/pnpm-store",
        "AIO_ENGINE_TOKEN_FILE=/run/aio/engine.token",
        "AIO_ENGINE_PORT=20411",
        "AIO_PROJECT_ROOT=/home/tester/work/app",
        `AIO_CONTAINER=${C}`,
        "AIO_ENGINE_VERSION=1.0.0",
        "AIO_STATE_DIR=/run/aio",
        `AIO_PROJECT_ID=${input.projectId}`,
        "AIO_BROKER_SOCKET=/run/aio-broker/broker.sock",
      ],
      binds: [
        "/home/tester/work/app:/home/tester/work/app",
        "/home/tester/.ai-orchestrator/accounts:/home/tester/.ai-orchestrator/accounts",
        `/home/tester/.ai-orchestrator/sessions/${C}:/home/tester/.ai-orchestrator/accounts/claude/fixture/sessions`,
        "/home/tester/.ai-orchestrator/transcripts/claude:/home/tester/.ai-orchestrator/transcripts/claude",
        "/data/ref:/data/ref",
        "/data/shared:/shared",
        "/home/tester/Bin/.project_archive:/home/tester/Bin/.project_archive",
        `/home/tester/.ai-orchestrator/state/${C}:/run/aio`,
        `/home/tester/.ai-orchestrator/broker/${brokerDirName(C)}:/run/aio-broker:ro`,
        `/home/tester/.ai-orchestrator/engine-config/${brokerDirName(C)}:/run/aio-config:ro`,
      ],
      portBindings: {
        "20411/tcp": [{ hostIp: "127.0.0.1", hostPort: "41000" }],
        "3000/tcp": [{ hostIp: "127.0.0.1", hostPort: "8080" }],
      },
      labels: {
        "aio.project": "app-1a2b3c4d",
        "aio.tcp-maps": "127.0.0.1:8080:3000",
        "aio.secret-names": "API_KEY,GITHUB_TOKEN",
        "aio.engine-version": "1.0.0",
        "aio.sudo": "off",
        "aio.secrets": "broker",
        "aio.accounts-mode": "accounts",
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
      { accountLinkTargets: [], hasGitconfig: false },
    );
    expect(spec.env.some((e) => e.startsWith("GIT_CONFIG_GLOBAL="))).toBe(false);
    expect(spec.binds).toHaveLength(9);
    expect(Object.keys(spec.portBindings)).toEqual(["20411/tcp"]);
    expect(spec.labels["aio.secret-names"]).toBe("");
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
      { accountLinkTargets: [], hasGitconfig: false },
    );
    expect(spec.portBindings["3000/tcp"]).toEqual([{ hostIp: "127.0.0.1", hostPort: "8080" }]);
    expect(spec.portBindings["4000/tcp"]).toEqual([{ hostIp: "", hostPort: "9090" }]);
    expect(spec.labels["aio.tcp-maps"]).toBe("127.0.0.1:8080:3000,9090:4000");
    expect(toDockerRunArgs(spec)).toContain("9090:4000");
  });

  it("refuses a relative root or a mount docker can't bind", () => {
    const facts = { accountLinkTargets: [], hasGitconfig: false };
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
    const built = buildLaunchSpec(env, input, { accountLinkTargets: [], hasGitconfig: false });
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
    expect(args).toContain("AIO_ENGINE_TOKEN_FILE=/run/aio/engine.token");
    expect(args.join(" ")).not.toContain(input.engine.token);
    expect(args).toContain("GITHUB_TOKEN=***");
    expect(args).toContain("AIO_BROKER_SOCKET=/run/aio-broker/broker.sock");
    expect(args).toContain(
      `/home/tester/.ai-orchestrator/broker/${brokerDirName(C)}:/run/aio-broker:ro`,
    );
    expect(args.join(" ")).not.toContain("ghp_value");
    expect(args).toContain("127.0.0.1:41000:20411");
    expect(args).toContain("127.0.0.1:8080:3000");
    expect(args.indexOf("aio-agent")).toBe(args.length - 1 - spec.cmd.length);
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
    const home = tempDir("aio-launch-");
    const e = { ...env, home };
    const root = path.join(home, "work");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "gitconfig"), "[safe]\n\tdirectory = *\n");
    const sessions = path.join(home, ".ai-orchestrator", "sessions", C);
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "11.json"), "{}");
    const shared = path.join(home, ".ai-orchestrator", "transcripts", "claude");
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(path.join(home, ".ai-orchestrator/accounts/claude/fixture"), { recursive: true });
    fs.symlinkSync(shared, path.join(home, ".ai-orchestrator/accounts/claude/fixture", "projects"));

    const accountDir = path.join(home, ".ai-orchestrator/accounts/claude/fixture");
    const facts = prepareLaunchHost(e, {
      container: C,
      root,
      accounts: { claudeDirs: [accountDir] },
    });
    expect(facts).toEqual({ accountLinkTargets: [shared], hasGitconfig: true });
    expect(fs.statSync(path.join(accountDir, "sessions")).isDirectory()).toBe(true);
    for (const d of [".claude", ".codex", ".copilot"])
      expect(fs.existsSync(path.join(home, d))).toBe(false);
    expect(fs.readdirSync(sessions)).toEqual([]);
    expect(fs.existsSync(path.join(home, ".ai-orchestrator", "state", C))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("leaves an existing ~/.claude.json alone", () => {
    const home = tempDir("aio-launch-");
    const root = path.join(home, "work");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(home, ".claude.json"), '{"SYNTHETIC":1}');
    prepareLaunchHost({ ...env, home }, { container: C, root });
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe('{"SYNTHETIC":1}');
  });

  it("ignores a projects symlink that points inside ~/.claude", () => {
    const home = tempDir("aio-launch-");
    fs.mkdirSync(path.join(home, ".ai-orchestrator/accounts/claude/fixture", "real"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(home, ".ai-orchestrator/accounts/claude/fixture", "real"),
      path.join(home, ".ai-orchestrator/accounts/claude/fixture", "projects"),
    );
    expect(linkTargetsOutside(path.join(home, ".ai-orchestrator/accounts/claude/fixture"))).toEqual(
      [],
    );
    fs.rmSync(path.join(home, ".ai-orchestrator/accounts/claude/fixture", "projects"));
    fs.mkdirSync(path.join(home, ".ai-orchestrator/accounts/claude/fixture", "projects"));
    expect(linkTargetsOutside(path.join(home, ".ai-orchestrator/accounts/claude/fixture"))).toEqual(
      [],
    );
  });

  describe("projects link chains", () => {
    function chainHome(): { home: string; store: string; shared: string } {
      const home = fs.realpathSync(tempDir("aio-launch-"));
      const store = path.join(home, ".ai-orchestrator", "transcripts", "claude");
      fs.mkdirSync(store, { recursive: true });
      fs.mkdirSync(path.join(home, ".ai-orchestrator/accounts/claude/fixture"), {
        recursive: true,
      });
      return { home, store, shared: path.join(home, "intermediate-link") };
    }

    it("follows a chain: projects -> intermediate link -> store", () => {
      const { home, store, shared } = chainHome();
      fs.symlinkSync(store, shared);
      fs.symlinkSync(
        shared,
        path.join(home, ".ai-orchestrator/accounts/claude/fixture", "projects"),
      );
      // The link path binds at its own path (docker follows it to the store),
      // and the store binds at its own path, so the chain resolves inside.
      expect(
        linkTargetsOutside(path.join(home, ".ai-orchestrator/accounts/claude/fixture")),
      ).toEqual([shared]);
    });

    it("follows a relative link in the chain", () => {
      const { home, store, shared } = chainHome();
      fs.symlinkSync(path.relative(home, store), shared);
      fs.symlinkSync(
        "../../../../intermediate-link",
        path.join(home, ".ai-orchestrator/accounts/claude/fixture", "projects"),
      );
      expect(
        linkTargetsOutside(path.join(home, ".ai-orchestrator/accounts/claude/fixture")),
      ).toEqual([shared]);
    });

    it("mounts the store once for the final direct link", () => {
      const { home, store } = chainHome();
      fs.symlinkSync(
        store,
        path.join(home, ".ai-orchestrator/accounts/claude/fixture", "projects"),
      );
      expect(
        linkTargetsOutside(path.join(home, ".ai-orchestrator/accounts/claude/fixture")),
      ).toEqual([store]);
    });

    it("mounts nothing for a dangling link", () => {
      const { home, store } = chainHome();
      fs.rmSync(store, { recursive: true });
      fs.symlinkSync(
        store,
        path.join(home, ".ai-orchestrator/accounts/claude/fixture", "projects"),
      );
      expect(
        linkTargetsOutside(path.join(home, ".ai-orchestrator/accounts/claude/fixture")),
      ).toEqual([]);
    });

    it("turns the chain into binds in the launch spec", () => {
      const { home, store, shared } = chainHome();
      const spec = buildLaunchSpec({ ...env, home }, input, {
        accountLinkTargets: [shared, store],
        hasGitconfig: false,
      });
      expect(spec.binds).toEqual(
        expect.arrayContaining([`${shared}:${shared}`, `${store}:${store}`]),
      );
    });
  });
});

describe("buildLaunchSpec broker transport", () => {
  const facts = { accountLinkTargets: [], hasGitconfig: false };

  it("leaves a Unix socket launch exactly as it was without a transport", () => {
    const plain = buildLaunchSpec(env, input, facts);
    const unix = buildLaunchSpec(env, { ...input, broker: { transport: "unix" } }, facts);
    expect(unix).toEqual(plain);
    expect(plain).not.toHaveProperty("extraHosts");
    expect(plain.labels).not.toHaveProperty("aio.broker-transport");
    expect(plain.env.some((e) => e.startsWith("AIO_BROKER_URL="))).toBe(false);
  });

  it("sets the URL in place of the socket for TCP, and keeps the mount", () => {
    const spec = buildLaunchSpec(
      env,
      { ...input, broker: { transport: "tcp", port: 41500, hostGateway: false } },
      facts,
    );
    expect(spec.env).toContain("AIO_BROKER_URL=http://host.docker.internal:41500");
    expect(spec.env.some((e) => e.startsWith("AIO_BROKER_SOCKET="))).toBe(false);
    expect(spec.binds).toContain(
      `/home/tester/.ai-orchestrator/broker/${brokerDirName(C)}:/run/aio-broker:ro`,
    );
    expect(spec.labels["aio.broker-transport"]).toBe("tcp");
    // Docker Desktop resolves host.docker.internal itself.
    expect(spec).not.toHaveProperty("extraHosts");
    // The broker port is a host port the server listens on, not a published one.
    expect(Object.keys(spec.portBindings).sort()).toEqual(["20411/tcp", "3000/tcp"]);
    // No token in the environment: the client reads it from the mounted file.
    expect(spec.env.join("\n")).not.toMatch(/TOKEN=/);
  });

  it("adds host-gateway for TCP on a native Linux engine, and shows it as --add-host", () => {
    const spec = buildLaunchSpec(
      env,
      { ...input, broker: { transport: "tcp", port: 41500, hostGateway: true } },
      facts,
    );
    expect(spec.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
    const args = toDockerRunArgs(spec);
    expect(args.join(" ")).toContain("--add-host host.docker.internal:host-gateway");
    expect(args).toContain("AIO_BROKER_URL=http://host.docker.internal:41500");
  });
});
