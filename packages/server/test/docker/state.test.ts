import fs from "node:fs";
import os from "node:os";
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

function env(now = () => new Date()): HostEnv {
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-state-")), user: "tester", now };
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
    expect(prepareStateDir(e, "c1", "/run/claude-box")).toBe(
      `${path.dirname(stateFile(e, "c1"))}:/run/claude-box`,
    );
    expect(fs.existsSync(stateFile(e, "c1"))).toBe(false);
  });

  it("records mounts", () => {
    const e = env();
    expect(readMountsFile(e, "c1")).toBeNull();
    writeMountsFile(e, "c1", ["/a:/a", "/b:/c"]);
    expect(readMountsFile(e, "c1")).toEqual(["/a:/a", "/b:/c"]);
  });
});
