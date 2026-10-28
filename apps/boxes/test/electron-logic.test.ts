import { describe, expect, it } from "vitest";
import {
  findTerminal,
  isBoxNotification,
  reviewCommand,
  serverUrl,
  terminalCandidates,
  terminalCommand,
  trayCounts,
  trayIconBitmap,
  trayText,
} from "../electron/logic";

describe("external terminals", () => {
  it("tries $TERMINAL first, then the inventory list", () => {
    expect(terminalCandidates({})).toEqual([
      "x-terminal-emulator",
      "gnome-terminal",
      "xterm",
      "kitty",
      "alacritty",
    ]);
    expect(terminalCandidates({ TERMINAL: "kitty" })).toEqual([
      "kitty",
      "x-terminal-emulator",
      "gnome-terminal",
      "xterm",
      "alacritty",
    ]);
  });
  it("builds each terminal's command line", () => {
    const argv = ["docker", "exec", "-it", "c", "tmux", "attach", "-t", "=s"];
    expect(terminalCommand("/usr/bin/gnome-terminal", argv, "t").args).toEqual([
      "--title",
      "t",
      "--",
      ...argv,
    ]);
    expect(terminalCommand("/usr/bin/xterm", argv, "t").args).toEqual(["-T", "t", "-e", ...argv]);
    expect(terminalCommand("kitty", argv, "t").args).toEqual(["--title", "t", ...argv]);
    expect(terminalCommand("alacritty", argv, "t").args).toEqual(["--title", "t", "-e", ...argv]);
    expect(terminalCommand("/usr/bin/xfce4-terminal", argv, "t").args).toEqual([
      "--title",
      "t",
      "-x",
      ...argv,
    ]);
    expect(terminalCommand("foot", argv, "t").args).toEqual(["--title", "t", ...argv]);
    expect(terminalCommand("wezterm", argv, "t").args).toEqual(["start", "--", ...argv]);
    expect(terminalCommand("/usr/bin/x-terminal-emulator", argv, "t").args).toEqual([
      "-e",
      ...argv,
    ]);
  });
  it("finds the first candidate on PATH", () => {
    const have = new Set(["/usr/bin/xterm", "/opt/kitty"]);
    expect(findTerminal({ PATH: "/usr/local/bin:/usr/bin" }, (p) => have.has(p))).toBe(
      "/usr/bin/xterm",
    );
    expect(findTerminal({ PATH: "/usr/bin", TERMINAL: "/opt/kitty" }, (p) => have.has(p))).toBe(
      "/opt/kitty",
    );
    expect(findTerminal({ PATH: "/nowhere" }, () => false)).toBeNull();
  });
});

describe("tray", () => {
  it("counts and words the status", () => {
    const c = trayCounts([{ status: "running" }, { status: "stopped" }, { status: "starting" }]);
    expect(c).toEqual({ running: 1, stopped: 1, transitioning: 1 });
    expect(trayText(c)).toBe("Agent Box: 1 running \u00b7 1 not running \u00b7 1 changing");
    expect(trayText(null)).toBe("Agent Box: server not reachable");
  });
  it("draws a BGRA icon with an opaque body and a transparent corner", () => {
    const buf = trayIconBitmap(22, "running");
    expect(buf.length).toBe(22 * 22 * 4);
    expect(buf[3]).toBe(0);
    const mid = (11 * 22 + 4) * 4;
    expect(buf[mid + 3]).toBe(255);
  });
});

describe("notifications and review", () => {
  it("keeps box notifications and leaves run ones to the review app", () => {
    expect(isBoxNotification({ kind: "box_ended", runId: null, boxId: "b" })).toBe(true);
    expect(
      isBoxNotification({ kind: "run_finished", runId: "01J00000000000000000000000", boxId: "b" }),
    ).toBe(false);
    expect(
      isBoxNotification({
        kind: "decision_needed",
        runId: "01J00000000000000000000000",
        boxId: null,
      }),
    ).toBe(false);
  });
  it("prefills the review launcher", () => {
    expect(reviewCommand("p", "b")).toEqual({
      file: "agentbox-review",
      args: ["--project=p", "--box=b"],
    });
    expect(reviewCommand("p", "b", "/opt/agentbox/review")).toEqual({
      file: "/opt/agentbox/review",
      args: ["--project=p", "--box=b"],
    });
    expect(reviewCommand("p", "b", "").file).toBe("agentbox-review");
  });
  it("reads the server URL from the environment", () => {
    expect(serverUrl({})).toBe("http://127.0.0.1:20400");
    expect(serverUrl({ AGENTBOX_SERVER_URL: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
  });
});
