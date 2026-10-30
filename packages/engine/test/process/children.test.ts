// The process-group record that lets a restarted engine stop what a crashed
// one left running.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../../src/adapters/process.js";
import {
  ChildRegistry,
  parseStat,
  setChildRegistry,
  type ProcReader,
} from "../../src/process/children.js";
import { tempDir } from "../tmp.js";

/** A `/proc/PID/stat` line with the fields the registry reads. */
function stat(pid: number, pgrp: number, start: number, comm = "sleep"): string {
  // Fields 3 to 9, eight counters (10 to 17), then 18 to 21, then field 22.
  return `${pid} (${comm}) S 1 ${pgrp} ${pgrp} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`;
}

function fakeProc(table: Record<number, string>): ProcReader {
  return {
    stat: (pid) => table[pid] ?? null,
    pids: () => Object.keys(table).map(Number),
  };
}

afterEach(() => setChildRegistry(null));

describe("parseStat", () => {
  it("reads the group and start time past a command name with spaces and parentheses", () => {
    expect(parseStat(stat(42, 40, 12345, "a (b) c"))).toEqual({ pgrp: 40, start: "12345" });
  });
});

describe("ChildRegistry", () => {
  it("kills a group a crashed engine left running, after a real spawn", async () => {
    const file = join(tempDir("children-"), "engine-children.json");
    setChildRegistry(new ChildRegistry(file));
    const orphan = runProcess({ command: "sleep", args: ["30"], cwd: "/" });
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
    const recorded = JSON.parse(readFileSync(file, "utf8")) as { groups: unknown[] };
    expect(recorded.groups).toHaveLength(1);

    // The engine crashed; the keeper starts a new one, which reads the record.
    setChildRegistry(null);
    expect(new ChildRegistry(file).reap()).toBe(1);
    const result = await orphan;
    expect(result.signal).toBe("SIGKILL");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ groups: [] });
  });

  it("forgets a group when its process ends", async () => {
    const file = join(tempDir("children-"), "engine-children.json");
    setChildRegistry(new ChildRegistry(file));
    await runProcess({ command: "true", args: [], cwd: "/" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ groups: [] });
  });

  it("kills only groups that are still the recorded ones", () => {
    const file = join(tempDir("children-"), "engine-children.json");
    const instance = "500";
    writeFileSync(
      file,
      JSON.stringify({
        instance,
        groups: [
          { pgid: 100, start: "9000" }, // Still running: killed.
          { pgid: 200, start: "9100" }, // Pid reused by a later process: left alone.
          { pgid: 300, start: "9200" }, // Leader gone, a member remains: killed.
          { pgid: 400, start: "9300" }, // Gone entirely.
        ],
      }),
    );
    const proc = fakeProc({
      1: stat(1, 1, Number(instance)),
      100: stat(100, 100, 9000),
      200: stat(200, 200, 9999),
      301: stat(301, 300, 9201),
    });
    const killed: number[] = [];
    const registry = new ChildRegistry(file, proc, (pid) => killed.push(pid));
    expect(registry.reap()).toBe(2);
    expect(killed).toEqual([-100, -300]);
  });

  it("ignores a record from before the container restarted", () => {
    const file = join(tempDir("children-"), "engine-children.json");
    writeFileSync(
      file,
      JSON.stringify({ instance: "500", groups: [{ pgid: 100, start: "9000" }] }),
    );
    const proc = fakeProc({ 1: stat(1, 1, 777), 100: stat(100, 100, 9000) });
    const killed: number[] = [];
    expect(new ChildRegistry(file, proc, (pid) => killed.push(pid)).reap()).toBe(0);
    expect(killed).toEqual([]);
  });
});
