import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_MAX_AGE_SEC,
  allLiveSessions,
  liveSessions,
  parseSessions,
  prepareStateDir,
  readMountsFile,
  stateFile,
  writeMountsFile,
} from "../../src/docker/state.js";
import type { HostEnv } from "../../src/records/env.js";
import { tempDir } from "../tmp.js";

function env(now = () => new Date()): HostEnv {
  return { home: tempDir("aio-state-"), user: "tester", now };
}

describe("keeper state", () => {
  it("parses session lists", () => {
    expect(parseSessions("a\n b \n\nc")).toEqual(["a", "b", "c"]);
  });

  it("reads live sessions and treats an old file as empty", () => {
    const e = env();
    fs.mkdirSync(path.dirname(stateFile(e, "c1")), { recursive: true });
    fs.writeFileSync(stateFile(e, "c1"), "s1\ns2\n");
    expect(liveSessions(e, "c1")).toEqual(["s1", "s2"]);
    expect(allLiveSessions(e)).toEqual(["s1", "s2"]);
    const later = { ...e, now: () => new Date(Date.now() + (STATE_MAX_AGE_SEC + 1) * 1000) };
    expect(liveSessions(later, "c1")).toEqual([]);
    expect(liveSessions(e, "missing")).toEqual([]);
  });

  it("clears a stale sessions file when preparing the state directory", () => {
    const e = env();
    fs.mkdirSync(path.dirname(stateFile(e, "c1")), { recursive: true });
    fs.writeFileSync(stateFile(e, "c1"), "old\n");
    expect(prepareStateDir(e, "c1", "/run/aio")).toBe(
      `${path.dirname(stateFile(e, "c1"))}:/run/aio`,
    );
    expect(fs.existsSync(stateFile(e, "c1"))).toBe(false);
  });

  it("removes a directory left at the sessions path without following links", () => {
    const e = env();
    const outside = tempDir("aio-outside-");
    fs.writeFileSync(path.join(outside, "keep"), "x");
    fs.mkdirSync(stateFile(e, "c1"), { recursive: true });
    fs.symlinkSync(outside, path.join(stateFile(e, "c1"), "link"));
    prepareStateDir(e, "c1", "/run/aio");
    expect(fs.existsSync(stateFile(e, "c1"))).toBe(false);
    expect(fs.existsSync(path.join(outside, "keep"))).toBe(true);
  });

  it("records mounts", () => {
    const e = env();
    expect(readMountsFile(e, "c1")).toBeNull();
    writeMountsFile(e, "c1", ["/a:/a", "/b:/c"]);
    expect(readMountsFile(e, "c1")).toEqual(["/a:/a", "/b:/c"]);
  });

  it("refuses a FIFO or a link as the sessions file instead of blocking on it", () => {
    const e = env();
    const file = stateFile(e, "c1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync("mkfifo", [file]);
    const started = Date.now();
    expect(liveSessions(e, "c1")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);

    fs.rmSync(file);
    const outside = path.join(e.home, "SYNTHETIC_outside");
    fs.writeFileSync(outside, "s1\n");
    fs.symlinkSync(outside, file);
    expect(liveSessions(e, "c1")).toEqual([]);
  });

  it("replaces a link or a directory at the mounts path rather than writing through it", () => {
    const e = env();
    const file = path.join(path.dirname(stateFile(e, "c1")), "mounts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const victim = path.join(e.home, "SYNTHETIC_victim");
    fs.writeFileSync(victim, "keep\n");
    fs.symlinkSync(victim, file);
    expect(readMountsFile(e, "c1")).toBeNull();
    writeMountsFile(e, "c1", ["/x:/x"]);
    expect(fs.readFileSync(victim, "utf8")).toBe("keep\n");
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(readMountsFile(e, "c1")).toEqual(["/x:/x"]);

    fs.rmSync(file);
    fs.mkdirSync(path.join(file, "sub"), { recursive: true });
    writeMountsFile(e, "c1", ["/y:/y"]);
    expect(readMountsFile(e, "c1")).toEqual(["/y:/y"]);
  });
});
