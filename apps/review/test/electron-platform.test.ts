// Branches of the Electron main process that depend on the host operating
// system, with the host passed in.
import { describe, expect, it } from "vitest";
import {
  APP_USER_MODEL_ID,
  hostOsOf,
  protocolClientArgs,
  usesWindowClass,
} from "../electron/logic";

describe("the Review app on each host", () => {
  it("maps process.platform names and sets the window class only on Linux", () => {
    expect(["linux", "darwin", "win32", "openbsd"].map(hostOsOf)).toEqual([
      "linux",
      "darwin",
      "win32",
      "linux",
    ]);
    expect(usesWindowClass("linux")).toBe(true);
    expect(usesWindowClass("darwin")).toBe(false);
    expect(usesWindowClass("win32")).toBe(false);
    expect(APP_USER_MODEL_ID).toBe("dev.aio.review");
  });

  it("names Electron and the app for the link scheme only in Windows development", () => {
    expect(protocolClientArgs("linux", true, "/e", "/app")).toEqual(["aio-review"]);
    expect(protocolClientArgs("darwin", true, "/e", "/app")).toEqual(["aio-review"]);
    expect(protocolClientArgs("win32", false, "C:\\e.exe", "C:\\app")).toEqual(["aio-review"]);
    expect(protocolClientArgs("win32", true, "C:\\e.exe", "C:\\app")).toEqual([
      "aio-review",
      "C:\\e.exe",
      ["C:\\app"],
    ]);
    expect(protocolClientArgs("win32", true, "C:\\e.exe", undefined)).toEqual(["aio-review"]);
  });
});
