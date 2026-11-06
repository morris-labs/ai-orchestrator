import { describe, expect, it } from "vitest";
import {
  childEnv,
  closeHidesToTray,
  ERR_ABORTED,
  findTerminal,
  isBoxNotification,
  needsExtensionList,
  needsLocalPage,
  permissionAllowed,
  reviewCommand,
  showRetained,
  isMachineIdArg,
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
    expect(trayText(c)).toBe("AI Orchestrator: 1 running \u00b7 1 not running \u00b7 1 changing");
    expect(trayText(null)).toBe("AI Orchestrator: server not reachable");
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
      file: "aio-review",
      args: ["--project=p", "--box=b"],
    });
    expect(reviewCommand("p", "b", "/opt/ai-orchestrator/review")).toEqual({
      file: "/opt/ai-orchestrator/review",
      args: ["--project=p", "--box=b"],
    });
    expect(reviewCommand("p", "b", "").file).toBe("aio-review");
    expect(reviewCommand("p", "b", undefined, "node-b").args).toEqual([
      "--project=p",
      "--box=b",
      "--machine=node-b",
    ]);
  });
  it("passes only plain machine IDs to the review app", () => {
    for (const ok of ["local", "hub", "node-b", "01JB8Z5K3W6Q2V9X4T7R0M1N2Q", "pc.lan_2"]) {
      expect(isMachineIdArg(ok)).toBe(true);
    }
    for (const bad of ["", "-x", "a b", "a&b", "a/b", "a\nb", 7, null, "x".repeat(200)]) {
      expect(isMachineIdArg(bad)).toBe(false);
    }
  });
  it("keeps the server token out of a spawned process's environment", () => {
    const env = { PATH: "/usr/bin", AIO_SERVER_TOKEN: "secret", HOME: "/home/dev" };
    expect(childEnv(env)).toEqual({ PATH: "/usr/bin", HOME: "/home/dev" });
    expect(env.AIO_SERVER_TOKEN).toBe("secret");
  });
});

describe("the local page", () => {
  const server = "https://127.0.0.1:21400/boxes/";
  const local = "file:///opt/ai-orchestrator/renderer/index.html";
  const pages = [server, local];
  const failed = (url: string, errorCode = -102, isMainFrame = true) => ({
    url,
    errorCode,
    isMainFrame,
  });

  it("loads when the server's page fails to load", () => {
    expect(needsLocalPage(failed(server), server, "", pages)).toBe(true);
    expect(needsLocalPage(failed(server + "#/boxes"), server, server, pages)).toBe(true);
  });

  // Finding 6: the check used to read only the server URL and every frame.
  it("loads for a page URL outside the server URL, and never for a frame", () => {
    const dev = "http://localhost:5173/";
    expect(needsLocalPage(failed(dev), dev, "", [dev, local])).toBe(true);
    expect(needsLocalPage(failed(server, -102, false), server, server, pages)).toBe(false);
    expect(needsLocalPage(failed("https://127.0.0.1:21400/api/v1/x"), server, "", pages)).toBe(
      false,
    );
  });

  // Finding 4: a redirect the window blocked used to replace the page.
  it("keeps the app's page when the window cancelled a load", () => {
    expect(needsLocalPage(failed(server, ERR_ABORTED), server, server, pages)).toBe(false);
    expect(needsLocalPage(failed(server, ERR_ABORTED), server, local, pages)).toBe(false);
    // With nothing loaded yet, a cancelled first load still needs a page.
    expect(needsLocalPage(failed(server, ERR_ABORTED), server, "", pages)).toBe(true);
  });
});

describe("permissions", () => {
  const pages = ["https://127.0.0.1:21400/boxes/", "file:///app/renderer/index.html"];
  it("grants the clipboard to app pages and refuses everything else", () => {
    expect(permissionAllowed("clipboard-sanitized-write", pages[0]!, pages)).toBe(true);
    expect(permissionAllowed("clipboard-read", "https://127.0.0.1:21400/boxes/#/x", pages)).toBe(
      true,
    );
    for (const p of ["media", "geolocation", "notifications", "openExternal", "fullscreen"]) {
      expect(permissionAllowed(p, pages[0]!, pages)).toBe(false);
    }
    expect(permissionAllowed("clipboard-read", "https://example.com/", pages)).toBe(false);
  });
});

describe("closing the window", () => {
  it("hides to the tray on desktops that have one", () => {
    expect(closeHidesToTray({ XDG_CURRENT_DESKTOP: "KDE" }, null)).toBe(true);
    expect(closeHidesToTray({}, null)).toBe(true);
    expect(closeHidesToTray({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, null)).toBe(true);
    expect(needsExtensionList({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(false);
  });

  it("quits on stock GNOME unless an AppIndicator extension runs", () => {
    const gnome = { XDG_CURRENT_DESKTOP: "GNOME" };
    expect(needsExtensionList(gnome)).toBe(true);
    expect(closeHidesToTray(gnome, null)).toBe(false);
    expect(closeHidesToTray(gnome, "@as []")).toBe(false);
    expect(closeHidesToTray(gnome, "['appindicatorsupport@rgcjonas.gmail.com']")).toBe(true);
  });

  it("follows AIO_CLOSE_TO_TRAY over the desktop", () => {
    expect(closeHidesToTray({ XDG_CURRENT_DESKTOP: "GNOME", AIO_CLOSE_TO_TRAY: "1" }, null)).toBe(
      true,
    );
    expect(closeHidesToTray({ XDG_CURRENT_DESKTOP: "KDE", AIO_CLOSE_TO_TRAY: "0" }, null)).toBe(
      false,
    );
    expect(needsExtensionList({ XDG_CURRENT_DESKTOP: "GNOME", AIO_CLOSE_TO_TRAY: "0" })).toBe(
      false,
    );
  });
});

describe("showRetained", () => {
  function fakeNote() {
    const handlers: Record<string, () => void> = {};
    return {
      shown: false,
      on(event: "click" | "close", listener: () => void) {
        handlers[event] = listener;
      },
      show() {
        this.shown = true;
      },
      emit(event: "click" | "close") {
        handlers[event]?.();
      },
    };
  }

  it("keeps a notification until it is clicked, then runs the click handler", () => {
    const retained = new Set<ReturnType<typeof fakeNote>>();
    const note = fakeNote();
    let clicks = 0;
    showRetained(retained, note, () => clicks++);
    expect(note.shown).toBe(true);
    expect(retained.has(note)).toBe(true);
    note.emit("click");
    expect(clicks).toBe(1);
    expect(retained.has(note)).toBe(false);
  });

  it("releases a notification that closes without a click", () => {
    const retained = new Set<ReturnType<typeof fakeNote>>();
    const note = fakeNote();
    showRetained(retained, note, () => undefined);
    note.emit("close");
    expect(retained.size).toBe(0);
  });
});
