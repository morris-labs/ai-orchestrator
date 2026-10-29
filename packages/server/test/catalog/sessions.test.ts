import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  liveModelAndEffort,
  liveSessionName,
  readSessionEntries,
  sameModel,
  sessionEntryKey,
} from "../../src/catalog/index.js";
import { tempDir } from "../tmp.js";

let dir: string;
beforeEach(() => {
  dir = tempDir("sessions-");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readSessionEntries", () => {
  it("reads valid entries and skips the rest", async () => {
    fs.writeFileSync(
      path.join(dir, "11.json"),
      JSON.stringify({
        pid: 11,
        pidDomain: "d",
        procStart: "p",
        sessionId: "s1",
        name: "N",
        nameSource: "user",
        updatedAt: 5,
      }),
    );
    fs.writeFileSync(path.join(dir, "12.json"), "{half");
    fs.writeFileSync(path.join(dir, "13.json"), JSON.stringify({ pid: 0, sessionId: "s" }));
    fs.writeFileSync(path.join(dir, "14.json"), JSON.stringify({ pid: 14 }));
    fs.writeFileSync(path.join(dir, "x.txt"), "{}");
    const entries = await readSessionEntries(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ pid: 11, sessionId: "s1", nameIsUser: true, updatedAt: 5 });
    expect(sessionEntryKey(entries[0]!)).toBe("11|d|p");
    expect(await readSessionEntries(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("liveSessionName", () => {
  const e = (sessionId: string, updatedAt: number, name: string, nameIsUser: boolean) => ({
    file: "",
    pid: updatedAt,
    pidDomain: "",
    procStart: "",
    sessionId,
    name,
    entrypoint: "",
    updatedAt,
    nameIsUser,
  });
  it("takes the newest entry, filtered by uuid when given", () => {
    const entries = [e("a", 1, "one", true), e("b", 3, "three", false), e("a", 2, "two", true)];
    expect(liveSessionName(entries, null)).toEqual({ sessionId: "b", name: "" });
    expect(liveSessionName(entries, "a")).toEqual({ sessionId: "a", name: "two" });
    expect(liveSessionName(entries, "z")).toBeUndefined();
  });
});

describe("liveModelAndEffort", () => {
  it("reads the last real assistant entry", async () => {
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "assistant", requestedModel: "claude-opus-5", effort: "low" }),
        JSON.stringify({
          type: "assistant",
          message: { model: "claude-sonnet-5-5" },
          effort: "max",
        }),
        JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }),
        JSON.stringify({ type: "user" }),
      ].join("\n"),
    );
    expect(await liveModelAndEffort(file)).toEqual({ model: "claude-sonnet-5-5", effort: "max" });
    expect(await liveModelAndEffort(path.join(dir, "none"))).toEqual({});
  });
  it("reads only the tail of a large file", async () => {
    const file = path.join(dir, "big.jsonl");
    const head = JSON.stringify({ type: "assistant", requestedModel: "claude-opus-5" });
    fs.writeFileSync(file, `${head}\n${"x".repeat(5 * 1024 * 1024)}\n`);
    expect(await liveModelAndEffort(file)).toEqual({});
  });
});

describe("sameModel", () => {
  it("treats aliases as matching the ids they resolve to", () => {
    expect(sameModel("opus", "claude-opus-5-5")).toBe(true);
    expect(sameModel("opus[1m]", "claude-opus-5-5")).toBe(true);
    expect(sameModel("", "anything")).toBe(true);
    expect(sameModel("claude-opus-5-5[1m]", "claude-opus-5-5")).toBe(true);
    expect(sameModel("claude-opus-5", "claude-opus-5-5")).toBe(false);
    expect(sameModel("sonnet", "claude-opus-5-5")).toBe(false);
  });
});
