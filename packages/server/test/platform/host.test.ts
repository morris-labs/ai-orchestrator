import { describe, expect, it } from "vitest";
import { defaultImageContext } from "../../src/docker/image.js";
import { defaultStaticDir } from "../../src/api/static-dirs.js";
import { NodeProcessRunner } from "../../src/jobs/process.js";
import {
  bashScriptArgv,
  configDir,
  currentPlatform,
  defaultDataDir,
  dockerEndpoint,
  dockerodeOptions,
  gitBashCandidates,
  hasPosixModes,
  hostOsOf,
  hostPlatform,
  installHint,
  openerArgv,
  ptyArgv,
  serviceEnvFromFile,
  serviceManagerOf,
} from "../../src/platform/host.js";
import { containerUsername } from "../../src/records/env.js";

const linux = hostPlatform("linux", { home: "/home/alex" });
const mac = hostPlatform("darwin", { home: "/Users/alex" });
const win = hostPlatform("win32", { home: "C:\\Users\\alex" });

describe("the host platform", () => {
  it("maps process.platform names, with other Unix systems as Linux", () => {
    expect(hostOsOf("linux")).toBe("linux");
    expect(hostOsOf("darwin")).toBe("darwin");
    expect(hostOsOf("win32")).toBe("win32");
    expect(hostOsOf("freebsd")).toBe("linux");
    expect(currentPlatform("/home/alex").home).toBe("/home/alex");
  });

  it("keeps the data directory in the home directory on every host", () => {
    expect(defaultDataDir(linux)).toBe("/home/alex/.ai-orchestrator");
    expect(defaultDataDir(mac)).toBe("/Users/alex/.ai-orchestrator");
    expect(defaultDataDir(win)).toBe("C:\\Users\\alex\\.ai-orchestrator");
  });

  it("puts the configuration directory where each host expects it", () => {
    expect(configDir(linux)).toBe("/home/alex/.config/aio");
    expect(configDir({ ...linux, env: { XDG_CONFIG_HOME: "/srv/config" } })).toBe(
      "/srv/config/aio",
    );
    // macOS ignores XDG_CONFIG_HOME, like op and gh do.
    expect(configDir({ ...mac, env: { XDG_CONFIG_HOME: "/srv/config" } })).toBe(
      "/Users/alex/.config/aio",
    );
    expect(configDir(win)).toBe("C:\\Users\\alex\\AppData\\Roaming\\aio");
    expect(configDir({ ...win, env: { APPDATA: "D:\\Roaming" } })).toBe("D:\\Roaming\\aio");
  });

  it("leaves Docker to dockerode's default on Linux and whenever DOCKER_HOST is set", () => {
    expect(dockerEndpoint(linux)).toEqual({ kind: "default" });
    expect(dockerodeOptions(dockerEndpoint(linux))).toBeUndefined();
    for (const p of [linux, mac, win]) {
      expect(dockerEndpoint({ ...p, env: { DOCKER_HOST: "tcp://192.0.2.10:2375" } })).toEqual({
        kind: "default",
      });
    }
  });

  it("uses the Docker Desktop pipe on Windows", () => {
    expect(dockerodeOptions(dockerEndpoint(win))).toEqual({ socketPath: "//./pipe/docker_engine" });
  });

  it("finds the first Docker socket that exists on macOS", () => {
    expect(dockerEndpoint(mac)).toEqual({ kind: "socket", socketPath: "/var/run/docker.sock" });
    const only = (path: string) => ({ ...mac, exists: (p: string) => p === path });
    expect(dockerEndpoint(only("/Users/alex/.docker/run/docker.sock"))).toEqual({
      kind: "socket",
      socketPath: "/Users/alex/.docker/run/docker.sock",
    });
    expect(dockerEndpoint(only("/Users/alex/.colima/default/docker.sock")).kind).toBe("socket");
    const both = {
      ...mac,
      exists: (p: string) =>
        p === "/var/run/docker.sock" || p === "/Users/alex/.orbstack/run/docker.sock",
    };
    expect(dockerodeOptions(dockerEndpoint(both))).toEqual({ socketPath: "/var/run/docker.sock" });
  });

  it("names a service manager and an opener per host", () => {
    expect([linux, mac, win].map(serviceManagerOf)).toEqual(["systemd", "launchd", "schtasks"]);
    expect(openerArgv(linux, "https://example.com")).toEqual(["xdg-open", "https://example.com"]);
    expect(openerArgv(mac, "/Users/alex")).toEqual(["open", "/Users/alex"]);
    expect(openerArgv(win, "C:\\Users\\alex")).toEqual(["explorer.exe", "C:\\Users\\alex"]);
  });

  it("wraps a program in each host's pseudo-terminal, or in none on Windows", () => {
    const argv = ["ssh-copy-id", "--", "alex@example.com"];
    expect(ptyArgv(linux, argv, "ssh-copy-id -- alex@example.com")).toEqual([
      "script",
      "-q",
      "-f",
      "-e",
      "-c",
      "ssh-copy-id -- alex@example.com",
      "/dev/null",
    ]);
    expect(ptyArgv(mac, argv, "ignored")).toEqual(["script", "-q", "/dev/null", ...argv]);
    expect(ptyArgv(win, argv, "ignored")).toBeNull();
  });

  it("spawns through the host's wrapper", () => {
    const args = ["-t", "ed25519"];
    expect(new NodeProcessRunner("linux").spawnArgv("ssh-keygen", args, { pty: true })).toEqual([
      "script",
      ["-q", "-f", "-e", "-c", "ssh-keygen -t ed25519", "/dev/null"],
    ]);
    expect(new NodeProcessRunner("darwin").spawnArgv("ssh-keygen", args, { pty: true })).toEqual([
      "script",
      ["-q", "/dev/null", "ssh-keygen", "-t", "ed25519"],
    ]);
    expect(new NodeProcessRunner("win32").spawnArgv("ssh-keygen", args, { pty: true })).toEqual([
      "ssh-keygen",
      args,
    ]);
    expect(new NodeProcessRunner("linux").spawnArgv("ssh-keygen", args)).toEqual([
      "ssh-keygen",
      args,
    ]);
  });

  it("has POSIX file modes everywhere but Windows", () => {
    expect([linux, mac, win].map(hasPosixModes)).toEqual([true, true, false]);
  });

  it("runs bash scripts directly on Unix and through Git for Windows' bash", () => {
    expect(bashScriptArgv(linux, "/opt/build-image.sh", ["--tag", "t"])).toEqual([
      "/opt/build-image.sh",
      "--tag",
      "t",
    ]);
    expect(bashScriptArgv(mac, "/opt/build-image.sh", [])).toEqual(["/opt/build-image.sh"]);
    expect(bashScriptArgv(win, "C:\\aio\\build-image.sh", [])).toBeNull();
    expect(gitBashCandidates(win)).toEqual([
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Users\\alex\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
    ]);
    const userGit = {
      ...win,
      exists: (p: string) => p === "C:\\Users\\alex\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
    };
    expect(bashScriptArgv(userGit, "C:\\aio\\build-image.sh", ["--no-cache"])).toEqual([
      "C:\\Users\\alex\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
      "C:\\aio\\build-image.sh",
      "--no-cache",
    ]);
    expect(bashScriptArgv({ ...win, env: { AIO_BASH: "D:\\bash.exe" } }, "C:\\b.sh", [])).toEqual([
      "D:\\bash.exe",
      "C:\\b.sh",
    ]);
  });

  it("words install hints for each host and keeps the Linux ones", () => {
    expect(installHint(linux, "docker")).toBe(
      "Install Docker, start the daemon, and add your user to the docker group, then check again.",
    );
    expect(installHint(linux, "ssh")).toBe(
      "Install the ssh client with sudo apt install openssh-client.",
    );
    expect(installHint(mac, "docker")).toMatch(/Docker Desktop/);
    expect(installHint(win, "docker")).toMatch(/WSL 2/);
    expect(installHint(win, "ssh")).toMatch(/OpenSSH Client/);
  });
});

describe("the container user name per host", () => {
  it("keeps the Linux rules", () => {
    expect(containerUsername({ USER: "Alex" }, "linux")).toBe("Alex");
    expect(containerUsername({ USER: "a b" }, "linux")).toBe("user");
  });

  it("lowercases a macOS or Windows name and falls back when it isn't a Linux name", () => {
    expect(containerUsername({ USERNAME: "Alex" }, "win32")).toBe("alex");
    expect(containerUsername({ USER: "alex" }, "darwin")).toBe("alex");
    expect(containerUsername({ USERNAME: "Alex Doe" }, "win32")).toBe("user");
    expect(containerUsername({ USERNAME: "1alex" }, "win32")).toBe("user");
    expect(containerUsername({ USERNAME: "a".repeat(40) }, "win32")).toBe("user");
    expect(containerUsername({}, "win32")).toBe("user");
  });
});

describe("the files beside a bundled server", () => {
  const share = "/Applications/AI Orchestrator.app/Contents/Resources/runtime/share";

  it("finds the image context in share/image after the checkout and /usr/share", () => {
    const has =
      (...paths: string[]) =>
      (p: string) =>
        paths.includes(p);
    expect(defaultImageContext("/repo", has(`${share}/image/Dockerfile`), share)).toBe(
      `${share}/image`,
    );
    expect(
      defaultImageContext(
        "/repo",
        has("/repo/image/Dockerfile", `${share}/image/Dockerfile`),
        share,
      ),
    ).toBe("/repo/image");
    expect(defaultImageContext("/repo", has(), share)).toBe("/repo/image");
  });

  it("finds the web bundles in share/web", () => {
    const has = (p: string) => p === `${share}/web/boxes/index.html`;
    expect(defaultStaticDir("/repo", "boxes", has, share)).toBe(`${share}/web/boxes`);
    expect(defaultStaticDir("/repo", "review", has, share)).toBe("/repo/apps/review/dist/renderer");
  });
});

describe("the op.env file on macOS and Windows", () => {
  const text = [
    "# 1Password",
    'OP_SERVICE_ACCOUNT_TOKEN="ops_example"',
    "OP_ACCOUNT=example.1password.com",
    "PATH=/tmp/evil",
    "NODE_OPTIONS=--require /tmp/evil.js",
    "not a pair",
    "",
  ].join("\r\n");

  it("returns only OP_ variables that the environment doesn't set", () => {
    const files: string[] = [];
    const read = (f: string) => {
      files.push(f);
      return text;
    };
    expect(serviceEnvFromFile({ ...mac, env: { OP_ACCOUNT: "set" } }, read)).toEqual({
      OP_SERVICE_ACCOUNT_TOKEN: "ops_example",
    });
    expect(serviceEnvFromFile(win, read)).toEqual({
      OP_SERVICE_ACCOUNT_TOKEN: "ops_example",
      OP_ACCOUNT: "example.1password.com",
    });
    expect(files).toEqual([
      "/Users/alex/.config/aio/op.env",
      "C:\\Users\\alex\\AppData\\Roaming\\aio\\op.env",
    ]);
  });

  it("reads nothing on Linux, where systemd loads the file, or when it's missing", () => {
    expect(serviceEnvFromFile(linux, () => text)).toEqual({});
    expect(serviceEnvFromFile(mac, () => null)).toEqual({});
  });
});
