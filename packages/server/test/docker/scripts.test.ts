// The 3.3.5 keeper and session start scripts stay verbatim from inventory
// section 4.2 as the reference for the image's keeper.sh and
// start-session.sh; this test reads the inventory itself.
import { execFileSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KEEPER_PATH,
  KEEPER_SCRIPT,
  OWN_MOUNT_PARENTS_SCRIPT,
  SESSION_START_SCRIPT,
  START_SESSION_PATH,
  STATE_MOUNT,
  buildSessionCommand,
  sessionStartCmd,
  sharedKeeperCommand,
  shellQuote,
} from "../../src/docker/scripts.js";

const inventory = fs.readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../docs/v4/inventory-gui.md",
  ),
  "utf8",
);

function codeBlockAfter(marker: string): string {
  const at = inventory.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = inventory.indexOf("```\n", at) + 4;
  return inventory.slice(start, inventory.indexOf("```", start));
}

describe("scripts", () => {
  it("keeps the keeper script verbatim", () => {
    expect(KEEPER_SCRIPT).toBe(codeBlockAfter("Keeper:\n```"));
  });

  it("keeps the session start script verbatim", () => {
    expect(SESSION_START_SCRIPT).toBe(codeBlockAfter("Session start (via"));
  });

  // 4.0.0 runs the image's keeper.sh, which does what the 3.3.5 keeper did
  // and also keeps the engine running, instead of the inline 3.3.5 script.
  it("runs the image's keeper after trusting every directory for git", () => {
    expect(sharedKeeperCommand()).toEqual([
      "bash",
      "-c",
      `git config --global --add safe.directory '*' 2>/dev/null; (shift 2; ${OWN_MOUNT_PARENTS_SCRIPT}); exec ${KEEPER_PATH} "$1" "$2"`,
      "_",
      STATE_MOUNT,
      "30",
    ]);
    expect(sharedKeeperCommand(2).at(-1)).toBe("2");
    expect(sharedKeeperCommand(2, ["/tmp/a/b"]).slice(-2)).toEqual(["2", "/tmp/a/b"]);
  });

  it("gives the user the root-owned parents of a mount under /tmp or home, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-parents-"));
    // The home directory must sit outside /tmp, or /tmp's rule covers it too.
    const home = mkdtempSync(join(path.dirname(fileURLToPath(import.meta.url)), ".home-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const log = join(dir, "sudo.log");
      // Every directory reads as root-owned; sudo records what it would chown.
      writeFileSync(join(bin, "stat"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "sudo"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, {
        mode: 0o755,
      });
      writeFileSync(join(bin, "id"), '#!/bin/sh\n[ "$1" = -u ] && echo 1000 || echo 1000\n', {
        mode: 0o755,
      });
      mkdirSync(join(home, "deep", "er"), { recursive: true });
      const tmpProject = mkdtempSync(join(tmpdir(), "own-parents-tmp-"));
      mkdirSync(join(tmpProject, "x", "y"), { recursive: true });
      const [, , script, ...args] = sharedKeeperCommand(1, [
        join(tmpProject, "x", "y", "repo"),
        join(home, "deep", "er", "mount"),
        "/usr/share/mount",
      ]);
      // Run only the ownership step: replace the keeper with a no-op.
      const body = script!.replace(/exec \S+ "\$1" "\$2"$/, "true");
      execFileSync("bash", ["-c", body, ...args], {
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
      });
      const calls = readFileSync(log, "utf8").trim().split("\n");
      rmSync(tmpProject, { recursive: true, force: true });
      const owned = calls.map((c) => c.replace("-n chown 1000:1000 -- ", ""));
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
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
    expect(KEEPER_PATH).toBe("/usr/local/lib/agentbox/keeper.sh");
    expect(START_SESSION_PATH).toBe("/usr/local/lib/agentbox/start-session.sh");
  });

  it("runs the session command through a shell as one argument per token", () => {
    const cmd = buildSessionCommand("printf", ["%s|", "multi word", "it's"]);
    expect(execFileSync("bash", ["-c", cmd], { encoding: "utf8" })).toBe("multi word|it's|");
  });
});
