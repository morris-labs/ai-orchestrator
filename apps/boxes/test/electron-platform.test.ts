// Branches of the Electron main process that depend on the host operating
// system, with the host passed in.
import { describe, expect, it } from "vitest";
import {
  applicationMenuTemplate,
  cliAttachArgs,
  hostOsOf,
  macTerminalCommand,
  mayAskGsettings,
  reviewCommand,
  reviewLaunch,
  usesWindowClass,
  windowsBundledCli,
  windowsTerminalCommand,
} from "../electron/logic";

describe("the Boxes app on each host", () => {
  it("maps process.platform names", () => {
    expect(["linux", "darwin", "win32", "freebsd"].map(hostOsOf)).toEqual([
      "linux",
      "darwin",
      "win32",
      "linux",
    ]);
  });

  it("sets the window class and asks gsettings only on Linux", () => {
    expect(usesWindowClass("linux")).toBe(true);
    expect(usesWindowClass("darwin")).toBe(false);
    expect(usesWindowClass("win32")).toBe(false);
    const gnome = { XDG_CURRENT_DESKTOP: "GNOME" };
    expect(mayAskGsettings("linux", gnome)).toBe(true);
    expect(mayAskGsettings("darwin", gnome)).toBe(false);
    expect(mayAskGsettings("win32", gnome)).toBe(false);
  });

  it("has a menu bar with Edit roles only on macOS", () => {
    expect(applicationMenuTemplate("linux")).toBeNull();
    expect(applicationMenuTemplate("win32")).toBeNull();
    expect(applicationMenuTemplate("darwin")).toEqual([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]);
  });

  it("runs the attach command in Terminal.app on macOS", () => {
    const cmd = macTerminalCommand([
      "docker",
      "exec",
      "-it",
      "aio-agent-proj-1",
      "bash",
      "-c",
      'tmux attach -t "=$1"',
      "_",
      "s1",
    ]);
    expect(cmd.file).toBe("osascript");
    expect(cmd.args).toEqual([
      "-e",
      'tell application "Terminal"',
      "-e",
      "activate",
      "-e",
      `do script "docker exec -it aio-agent-proj-1 bash -c 'tmux attach -t \\"=$1\\"' _ s1"`,
      "-e",
      "end tell",
    ]);
  });

  it("turns an attach request into aio arguments", () => {
    expect(cliAttachArgs({ boxId: "b1", kind: "session" })).toEqual(["box", "attach", "b1"]);
    expect(cliAttachArgs({ boxId: "b1", kind: "side", platform: "codex" })).toEqual([
      "box",
      "attach",
      "b1",
      "--side",
      "codex",
    ]);
    expect(cliAttachArgs({ boxId: "b1", kind: "shell" })).toEqual(["box", "shell", "b1"]);
  });

  it("opens the aio CLI in Windows Terminal, or in a cmd.exe console", () => {
    const cli = windowsBundledCli(
      "C:\\Users\\alex\\AppData\\Local\\Programs\\ai-orchestrator\\resources",
    );
    const [node, entry] = cli;
    expect(node).toMatch(/\\resources\\runtime\\node\\node\.exe$/);
    expect(entry).toMatch(/\\resources\\runtime\\cli\\dist\\main\.js$/);
    expect(windowsTerminalCommand(cli, ["box", "attach", "b1"], "b1", true)).toEqual({
      file: "wt.exe",
      args: ["-w", "new", "new-tab", "--title", "b1", node, entry, "box", "attach", "b1"],
      verbatim: false,
    });
    expect(windowsTerminalCommand(cli, ["box", "attach", "b1"], "b1", false)).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `"start "b1" "${node}" "${entry}" box attach b1"`],
      verbatim: true,
    });
  });

  it("accepts install paths with characters that are safe in quotes", () => {
    for (const resources of [
      "C:\\Program Files (x86)\\AI Orchestrator\\resources",
      "C:\\Users\\O'Brien\\Programs\\aio\\resources",
      "C:\\Users\\Jos\u00e9\\Programs\\aio\\resources",
      "D:\\R&D\\aio\\resources",
    ]) {
      const cli = windowsBundledCli(resources);
      const [node, entry] = cli;
      expect(windowsTerminalCommand(cli, ["box", "attach", "b1"], "b1", true)?.args).toEqual([
        "-w",
        "new",
        "new-tab",
        "--title",
        "b1",
        node,
        entry,
        "box",
        "attach",
        "b1",
      ]);
      expect(windowsTerminalCommand(cli, ["box", "attach", "b1"], "b1", false)?.args).toEqual([
        "/d",
        "/s",
        "/c",
        `"start "b1" "${node}" "${entry}" box attach b1"`,
      ]);
    }
  });

  it("refuses an install path that a quoted path can't protect", () => {
    for (const bad of ["C:\\100%\\aio.cmd", "C:\\a;b\\aio.cmd", 'C:\\a"b\\aio.cmd', "C:\\a\nb"]) {
      expect(windowsTerminalCommand([bad], ["box"], "t", true)).toBeNull();
      expect(windowsTerminalCommand([bad], ["box"], "t", false)).toBeNull();
    }
  });

  it("refuses arguments that cmd.exe or Windows Terminal would parse", () => {
    for (const bad of ["b1&calc", "b1;x", 'b"1', "b1|x", "%PATH%", "b1^", "b(1)", "b'1"]) {
      expect(windowsTerminalCommand(["aio.cmd"], ["box", "attach", bad], "t", false)).toBeNull();
      expect(windowsTerminalCommand(["aio.cmd"], ["box", "attach", "b1"], bad, false)).toBeNull();
    }
  });

  it("starts the review app with its command on Linux and its link elsewhere", () => {
    const link = { projectId: "p1", boxId: "b1" };
    expect(reviewLaunch("linux", link, undefined)).toEqual(reviewCommand("p1", "b1"));
    expect(reviewLaunch("linux", {}, undefined)).toEqual({ file: "aio-review", args: [] });
    expect(reviewLaunch("darwin", link, undefined)).toEqual({
      url: "aio-review://launch?project=p1&box=b1",
    });
    expect(reviewLaunch("win32", {}, undefined)).toEqual({ url: "aio-review://launch" });
    const remote = { ...link, machineId: "node-b" };
    expect(reviewLaunch("darwin", remote, undefined)).toEqual({
      url: "aio-review://launch?project=p1&box=b1&machine=node-b",
    });
    expect(reviewLaunch("linux", remote, undefined)).toEqual(
      reviewCommand("p1", "b1", undefined, "node-b"),
    );
    expect(reviewLaunch("darwin", link, "/opt/review")).toEqual(
      reviewCommand("p1", "b1", "/opt/review"),
    );
  });
});
