// The 3.3.5 keeper and session start scripts stay verbatim from inventory
// section 4.2 as the reference for the image's keeper.sh and
// start-session.sh; this test reads the inventory itself.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KEEPER_PATH,
  KEEPER_SCRIPT,
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
      `git config --global --add safe.directory '*' 2>/dev/null; exec ${KEEPER_PATH} "$1" "$2"`,
      "_",
      STATE_MOUNT,
      "30",
    ]);
    expect(sharedKeeperCommand(2).at(-1)).toBe("2");
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
