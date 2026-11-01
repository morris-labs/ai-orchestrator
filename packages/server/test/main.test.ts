import os from "node:os";
import { describe, expect, it } from "vitest";
import path from "node:path";
import { execStartLine, main, parseServerArgs, serverHome } from "../src/main.js";

describe("main", () => {
  it("uses AIO_HOME when set, else the home directory", () => {
    expect(serverHome({ AIO_HOME: "/tmp/aio-test/../scratch" })).toBe("/tmp/scratch");
    expect(serverHome({})).toBe(os.homedir());
    expect(serverHome({ AIO_HOME: "" })).toBe(os.homedir());
  });

  it("refuses an unknown command", async () => {
    expect(await main(["bogus"])).toBe(2);
  });

  it("reads --data-dir in both forms, ahead of AIO_DATA_DIR", () => {
    expect(parseServerArgs([], {})).toEqual({ command: undefined, dataDir: undefined });
    expect(parseServerArgs([], { AIO_DATA_DIR: "/srv/a" }).dataDir).toBe("/srv/a");
    expect(parseServerArgs(["--data-dir", "/srv/b"], { AIO_DATA_DIR: "/srv/a" })).toEqual({
      command: undefined,
      dataDir: "/srv/b",
    });
    expect(parseServerArgs(["install-service", "--data-dir=rel"], {})).toEqual({
      command: "install-service",
      dataDir: path.resolve("rel"),
    });
  });

  it("rejects a --data-dir without a value and a second command", async () => {
    expect(parseServerArgs(["--data-dir"], {}).error).toMatch(/needs a directory/);
    expect(parseServerArgs(["a", "b"], {}).error).toMatch(/Unexpected argument: b/);
    expect(await main(["--data-dir"])).toBe(2);
  });

  it("passes the data directory on to the systemd unit, quoted when needed", () => {
    expect(execStartLine()).not.toContain("--data-dir");
    expect(execStartLine("/srv/data")).toMatch(/ --data-dir \/srv\/data$/);
    expect(execStartLine("/srv/my data")).toMatch(/ --data-dir "\/srv\/my data"$/);
  });
});
