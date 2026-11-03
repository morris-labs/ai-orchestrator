import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { execStartLine, logToFile, main, parseServerArgs, serverHome } from "../src/main.js";

describe("logToFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aio-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in for `process.stderr` that records what reaches it. */
  function fakeStderr() {
    const seen: string[] = [];
    const stderr = {
      write: ((chunk: string | Uint8Array, done?: () => void) => {
        seen.push(chunk.toString());
        done?.();
        return true;
      }) as NodeJS.WriteStream["write"],
    };
    return { seen, stderr };
  }

  it("has a message in the file when the write returns", () => {
    const { seen, stderr } = fakeStderr();
    const file = path.join(dir, "logs", "server.log");
    logToFile(file, stderr);
    stderr.write("one\n");
    expect(readFileSync(file, "utf8")).toBe("one\n");
    stderr.write(Buffer.from("two\n"));
    stderr.write("74687265650a", "hex");
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\nthree\n");
    expect(seen).toEqual([]);
  });

  it("calls a write's callback in both call forms", async () => {
    const { stderr } = fakeStderr();
    logToFile(path.join(dir, "server.log"), stderr);
    await new Promise<void>((resolve) => stderr.write("a\n", () => resolve()));
    await new Promise<void>((resolve) => stderr.write("b\n", "utf8", () => resolve()));
  });

  it("runs on when the file can't be opened", () => {
    const { seen, stderr } = fakeStderr();
    const original = stderr.write;
    logToFile(dir, stderr); // A directory.
    expect(seen.join("")).toContain(`can't write to the log file ${dir}`);
    expect(stderr.write).toBe(original);
  });

  it("runs on when the file's parent can't be created", () => {
    const { seen, stderr } = fakeStderr();
    const blocker = path.join(dir, "blocker");
    closeSync(openSync(blocker, "w"));
    logToFile(path.join(blocker, "server.log"), stderr);
    expect(seen.join("")).toContain("can't write to the log file");
  });

  // On Linux, every write to /dev/full fails with ENOSPC.
  it.skipIf(!existsSync("/dev/full"))("falls back when a write fails, and reports it once", () => {
    const { seen, stderr } = fakeStderr();
    logToFile("/dev/full", stderr);
    stderr.write("first\n");
    stderr.write("second\n");
    expect(seen.filter((s) => s.includes("can't write to the log file"))).toHaveLength(1);
    expect(seen.filter((s) => !s.includes("can't write"))).toEqual(["first\n", "second\n"]);
  });
});

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

  it("takes the role from --role, else AIO_ROLE, and refuses an unknown one", () => {
    expect(parseServerArgs([], {}).role).toBeUndefined();
    expect(parseServerArgs([], { AIO_ROLE: "hub" }).role).toBe("hub");
    expect(parseServerArgs(["--role", "node"], { AIO_ROLE: "hub" }).role).toBe("node");
    expect(parseServerArgs(["--role=both"], {}).role).toBe("both");
    expect(parseServerArgs(["--role", "boss"], {}).error).toMatch(
      /--role must be hub, node, or both/,
    );
    expect(parseServerArgs([], { AIO_ROLE: "x" }).error).toMatch(/AIO_ROLE must be/);
    expect(parseServerArgs(["--role"], {}).error).toMatch(/needs hub, node, or both/);
  });

  it("passes the data directory on to the systemd unit, quoted when needed", () => {
    expect(execStartLine()).not.toContain("--data-dir");
    expect(execStartLine("/srv/data")).toMatch(/ --data-dir \/srv\/data$/);
    expect(execStartLine("/srv/my data")).toMatch(/ --data-dir "\/srv\/my data"$/);
  });
});
