// The 3.3.5 keeper and session start scripts stay verbatim as the reference
// for the image's keeper.sh and start-session.sh. This test pins each one to
// the SHA-256 hash of its 3.3.5 text.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_SAFE_DIRECTORY_SETUP,
  HOME_LINKS_SCRIPT,
  KEEPER_PATH,
  KEEPER_SCRIPT,
  ROOT_SETUP_SCRIPT,
  SESSION_START_SCRIPT,
  START_SESSION_PATH,
  STATE_MOUNT,
  SUDOERS_FILE,
  buildSessionCommand,
  rootSetupExec,
  sessionStartCmd,
  sharedKeeperCommand,
  shellQuote,
  skippedHomeLinks,
} from "../../src/docker/scripts.js";

/**
 * Fake root tools in `dir/bin`: every directory reads as root-owned, and
 * `chown`, `usermod`, `visudo`, and `chpasswd` only record their calls (and
 * `chpasswd` its input) in `dir/calls.log`.
 */
function fakeRootTools(dir: string, options: { chpasswdFails?: boolean } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const tool = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  tool("stat", "echo 0");
  for (const name of ["chown", "usermod", "visudo"]) {
    tool(name, `printf '%s\\n' "${name} $*" >> '${log}'`);
  }
  tool(
    "chpasswd",
    options.chpasswdFails
      ? "exit 1"
      : `IFS= read -r line; printf '%s\\n' "chpasswd $* <<< $line" >> '${log}'`,
  );
  return { bin, log };
}

/** Runs the root setup step with the fake tools first on PATH. */
function runRootSetup(
  bin: string,
  sudoers: string,
  home: string,
  stdin: string,
  mountPaths: string[],
): void {
  execFileSync("/bin/sh", ["-c", ROOT_SETUP_SCRIPT, "_", "tester", home, sudoers, ...mountPaths], {
    input: stdin,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("scripts", () => {
  it("keeps the keeper script verbatim", () => {
    expect(sha256(KEEPER_SCRIPT)).toBe(
      "e973df18b9190f808633177aa6e5da3dd378c5714cf2c2a36b11e2052fd17d11",
    );
  });

  it("keeps the session start script verbatim", () => {
    expect(sha256(SESSION_START_SCRIPT)).toBe(
      "341a118d6d994acc3467f338dcd040a33af7cf0ade696710f6af779f7e72daa6",
    );
  });

  // 1.0.0 runs the image's keeper.sh, which does what the 3.3.5 keeper did
  // and also keeps the engine running, instead of the inline 3.3.5 script.
  it("runs the image's keeper after trusting every directory for git, without sudo", () => {
    expect(sharedKeeperCommand()).toEqual([
      "bash",
      "-c",
      `${GIT_SAFE_DIRECTORY_SETUP}; exec ${KEEPER_PATH} "$1" "$2"`,
      "_",
      STATE_MOUNT,
      "30",
    ]);
    expect(sharedKeeperCommand(2).at(-1)).toBe("2");
    expect(sharedKeeperCommand().join(" ")).not.toContain("sudo");
  });

  it("adds safe.directory to a project gitconfig once, however often the container starts", () => {
    const dir = mkdtempSync(join(tmpdir(), "safe-dir-"));
    try {
      const gitconfig = join(dir, "gitconfig");
      writeFileSync(gitconfig, "[user]\n\tname = Example\n");
      const run = () =>
        execFileSync("/bin/sh", ["-c", GIT_SAFE_DIRECTORY_SETUP], {
          env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_GLOBAL: gitconfig },
          stdio: ["ignore", "pipe", "pipe"],
        });
      run();
      run();
      run();
      const text = readFileSync(gitconfig, "utf8");
      expect(text.match(/directory = \*/g)).toHaveLength(1);
      expect(text).toContain("name = Example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the root setup step as root with system tools and the hash on standard input", () => {
    const hash = `$6$rounds=100000$SYNTHETICsalt$${"a".repeat(86)}`;
    const exec = rootSetupExec("tester", "/home/tester", ["/tmp/a/b"], hash);
    expect(exec.user).toBe("root");
    expect(exec.workingDir).toBe("/");
    expect(exec.cmd).toEqual([
      "/bin/sh",
      "-c",
      ROOT_SETUP_SCRIPT,
      "_",
      "tester",
      "/home/tester",
      SUDOERS_FILE,
      "/tmp/a/b",
    ]);
    expect(exec.stdin).toBe(`${hash}\n`);
    // The hash is in neither the command line nor the environment.
    expect(exec.cmd.join(" ")).not.toContain(hash);
    expect(exec.env.join(" ")).not.toContain(hash);
    // The container's PATH starts with directories the user can write.
    expect(exec.env).toContain("PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    expect(exec.env).toContain("LD_PRELOAD=");
    // It runs as root and never calls sudo as a command.
    expect(ROOT_SETUP_SCRIPT).not.toMatch(/(^|[;&|{(]|\$\()\s*sudo\s/m);
    expect(rootSetupExec("tester", "/home/tester", [], null).stdin).toBe("\n");
  });

  it("gives the user the root-owned parents of a mount under /tmp or home, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-parents-"));
    // The home directory must sit outside /tmp, or /tmp's rule covers it too.
    // /var/tmp is outside /tmp and outside the source tree, so a test that
    // stops early leaves nothing in the repository.
    const home = mkdtempSync(join("/var/tmp", "aio-own-parents-home-"));
    try {
      const { bin, log } = fakeRootTools(dir);
      mkdirSync(join(home, "deep", "er"), { recursive: true });
      const tmpProject = mkdtempSync(join(tmpdir(), "own-parents-tmp-"));
      mkdirSync(join(tmpProject, "x", "y"), { recursive: true });
      // A symbolic link among the parents is never followed or changed.
      fs.symlinkSync("/usr", join(home, "link"));
      runRootSetup(bin, join(dir, "sudoers"), home, "", [
        join(tmpProject, "x", "y", "repo"),
        join(home, "deep", "er", "mount"),
        join(home, "link", "share", "mount"),
        "/usr/share/mount",
      ]);
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter((c) => c.startsWith("chown "));
      rmSync(tmpProject, { recursive: true, force: true });
      const owned = calls.map((c) => c.replace("chown -h -- tester: ", ""));
      // The temporary directory can sit deeper under /tmp; every parent up
      // to /tmp counts, /tmp itself never does.
      const underTmp = owned.filter((d) => !d.startsWith(`${home}/`));
      expect(underTmp.slice(0, 3)).toEqual([
        join(tmpProject, "x", "y"),
        join(tmpProject, "x"),
        tmpProject,
      ]);
      expect(underTmp.every((d) => d.startsWith("/tmp/"))).toBe(true);
      expect(owned.filter((d) => d.startsWith(`${home}/`))).toEqual([
        join(home, "deep", "er"),
        join(home, "deep"),
      ]);
      expect(owned).not.toContain("/tmp");
      expect(owned).not.toContain(home);
      expect(owned.some((d) => d.startsWith("/usr"))).toBe(false);
      expect(owned.some((d) => d.startsWith(join(home, "link")))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never changes the owner of the home directory or its parents, even under /tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-home-"));
    try {
      const { bin, log } = fakeRootTools(dir);
      // A home under /tmp: the /tmp rule alone would also reach the home
      // and every parent of it.
      const home = join(dir, "home", "tester");
      mkdirSync(join(home, "deep", "mount"), { recursive: true });
      runRootSetup(bin, join(dir, "sudoers"), home, "", [join(home, "deep", "mount", "x")]);
      const owned = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter((c) => c.startsWith("chown "))
        .map((c) => c.replace("chown -h -- tester: ", ""));
      expect(owned).toEqual([join(home, "deep", "mount"), join(home, "deep")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns sudo off without a hash, removing an older image's passwordless rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "root-setup-"));
    try {
      const { bin, log } = fakeRootTools(dir);
      const sudoers = join(dir, "sudoers");
      writeFileSync(sudoers, "tester ALL=(ALL) NOPASSWD:ALL\n");
      runRootSetup(bin, sudoers, "/home/tester", "\n", []);
      expect(fs.existsSync(sudoers)).toBe(false);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["usermod -p ! -- tester"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs the hash and a rule that asks for the password every time", () => {
    const dir = mkdtempSync(join(tmpdir(), "root-setup-"));
    try {
      const { bin, log } = fakeRootTools(dir);
      const sudoers = join(dir, "sudoers");
      writeFileSync(sudoers, "tester ALL=(ALL) NOPASSWD:ALL\n");
      const hash = `$6$rounds=100000$SYNTHETICsalt$${"b".repeat(86)}`;
      // No end-of-file follows the line, as with the server's exec.
      runRootSetup(bin, sudoers, "/home/tester", `${hash}\n`, []);
      expect(readFileSync(sudoers, "utf8")).toBe(
        "tester ALL=(ALL:ALL) ALL\nDefaults:tester timestamp_timeout=0\n",
      );
      expect((fs.statSync(sudoers).mode & 0o777).toString(8)).toBe("440");
      expect(fs.existsSync(`${sudoers}.tmp`)).toBe(false);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      expect(calls).toEqual([`chpasswd -e <<< tester:${hash}`, `visudo -cqf ${sudoers}.tmp`]);
      // The hash appears only in what chpasswd read from its input.
      expect(calls.filter((c) => c.includes(hash))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails without a sudo rule when the hash can't be installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "root-setup-"));
    try {
      const { bin } = fakeRootTools(dir, { chpasswdFails: true });
      const sudoers = join(dir, "sudoers");
      writeFileSync(sudoers, "tester ALL=(ALL) NOPASSWD:ALL\n");
      expect(() =>
        runRootSetup(bin, sudoers, "/home/tester", `$6$rounds=1000$s$${"c".repeat(86)}\n`, []),
      ).toThrow();
      expect(fs.existsSync(sudoers)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quotes every byte safely for bash", () => {
    const tricky = [`it's "fine"`, "a b\tc\nd", "$HOME `x` $(y)", "Emails not sending!", "é漢字"];
    for (const s of tricky) {
      const out = execFileSync("bash", ["-c", `printf '%s' ${shellQuote(s)}`], {
        encoding: "utf8",
      });
      expect(out).toBe(s);
    }
    expect(buildSessionCommand("claude", ["--name", "a b"])).toBe("claude '--name' 'a b'");
    expect(sessionStartCmd("s", "/w", "c")).toEqual([START_SESSION_PATH, "s", "/w", "c"]);
    expect(KEEPER_PATH).toBe("/usr/local/lib/ai-orchestrator/keeper.sh");
    expect(START_SESSION_PATH).toBe("/usr/local/lib/ai-orchestrator/start-session.sh");
  });

  it("runs the session command through a shell as one argument per token", () => {
    const cmd = buildSessionCommand("printf", ["%s|", "multi word", "it's"]);
    expect(execFileSync("bash", ["-c", cmd], { encoding: "utf8" })).toBe("multi word|it's|");
  });
});

describe("HOME_LINKS_SCRIPT", () => {
  it("links missing and linked paths, and reports a real folder it leaves alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-home-links-"));
    try {
      const account = join(dir, "account");
      mkdirSync(account);
      const real = join(dir, "real");
      mkdirSync(real);
      const old = join(dir, "old");
      fs.symlinkSync(join(dir, "elsewhere"), old);
      const out = execFileSync(
        "/bin/sh",
        ["-c", HOME_LINKS_SCRIPT, "_", account, join(dir, "new"), account, real, account, old],
        { encoding: "utf8" },
      );
      expect(fs.readlinkSync(join(dir, "new"))).toBe(account);
      expect(fs.readlinkSync(old)).toBe(account);
      expect(fs.lstatSync(real).isSymbolicLink()).toBe(false);
      expect(skippedHomeLinks(out)).toEqual([real]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
