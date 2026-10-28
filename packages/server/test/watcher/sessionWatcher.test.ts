import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoxChangedEventSchema, type Box } from "@agentbox/contracts";
import { openDatabase, repositories, type Repositories } from "../../src/db/index.js";
import { sessionsDirFor, type HostEnv } from "../../src/records/env.js";
import { CoreEvents, type CoreEventPayload } from "../../src/records/events.js";
import { SessionWatcher } from "../../src/watcher/index.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const T = "2026-10-28T00:00:00.000Z";
const CONTAINER = "claude-agent-proj-proj-1234abcd";

let home: string;
let env: HostEnv;
let repos: Repositories;
let events: CoreEvents;
let published: CoreEventPayload[];
let watcher: SessionWatcher;

function box(id: string, extra: Partial<Box> = {}): Box {
  return repos.boxes.put({
    id,
    projectId: "proj-1234abcd",
    hostKey: id.replace("claude-agent-", ""),
    targetDir: "/work/proj",
    sessionUuid: U1,
    conversationName: "orig",
    transcriptSyncedName: "orig",
    platform: "claude",
    skipPermissions: true,
    container: CONTAINER,
    session: id,
    wasRunning: true,
    sshRemoteRefs: [],
    createdAt: T,
    updatedAt: T,
    ...extra,
  });
}

function entry(dir: string, file: string, data: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, file),
    JSON.stringify({ pidDomain: "d", procStart: "p", ...data }),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-"));
  env = { home, user: "tester", now: () => new Date("2026-10-29T00:00:00Z") };
  repos = repositories(openDatabase(":memory:"));
  repos.projects.put({
    id: "proj-1234abcd",
    root: "/work/proj",
    name: "proj",
    tcpMaps: [],
    mounts: [],
    secretRefs: [],
    policyPath: ".claude-box/policy.yaml",
    createdAt: T,
    updatedAt: T,
  });
  events = new CoreEvents();
  published = [];
  events.subscribe((p) => published.push(p));
  watcher = new SessionWatcher({ env, boxes: repos.boxes, events });
});
afterEach(() => {
  watcher.stop();
  repos.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("own directory", () => {
  it("ignores a leftover own directory for a box in a shared container", async () => {
    box("claude-agent-a");
    entry(sessionsDirFor(env, "claude-agent-a"), "11.json", {
      pid: 11,
      sessionId: U3,
      updatedAt: 1,
      name: "stale",
      nameSource: "user",
    });
    await watcher.setRunning(["claude-agent-a"]);
    expect(repos.boxes.get("claude-agent-a")!.sessionUuid).not.toBe(U3);
    expect(published).toHaveLength(0);
  });

  it("takes the first reading as the truth", async () => {
    box("claude-agent-a", { container: "claude-agent-a", session: "main" });
    const dir = sessionsDirFor(env, "claude-agent-a");
    entry(dir, "11.json", {
      pid: 11,
      sessionId: U3,
      updatedAt: 1,
      name: "old",
      nameSource: "user",
    });
    entry(dir, "12.json", {
      pid: 12,
      sessionId: U2,
      updatedAt: 2,
      name: "Renamed",
      nameSource: "user",
    });
    await watcher.setRunning(["claude-agent-a"]);
    const b = repos.boxes.get("claude-agent-a")!;
    expect(b).toMatchObject({
      sessionUuid: U2,
      conversationName: "Renamed",
      transcriptSyncedName: "Renamed",
    });
    expect(b.updatedAt).toBe("2026-10-29T00:00:00.000Z");
    expect(published).toHaveLength(1);
    BoxChangedEventSchema.parse({
      ...published[0],
      id: "e",
      time: T,
      source: "server",
      streamId: "s",
      seq: 1,
      sourceSeq: 1,
    });
    expect(await watcher.scan()).toEqual([]);
  });

  it("ignores an auto-generated name", async () => {
    box("claude-agent-a");
    entry(sessionsDirFor(env, "claude-agent-a"), "11.json", {
      pid: 11,
      sessionId: U1,
      updatedAt: 1,
      name: "auto",
    });
    await watcher.setRunning(["claude-agent-a"]);
    expect(repos.boxes.get("claude-agent-a")!.conversationName).toBe("orig");
    expect(published).toEqual([]);
  });
});

describe("shared directory", () => {
  it("matches by uuid, then follows the process through /clear and /rename", async () => {
    box("claude-agent-a");
    const dir = sessionsDirFor(env, CONTAINER);
    entry(dir, "11.json", { pid: 11, sessionId: U1, updatedAt: 1, name: "x", nameSource: "user" });
    await watcher.setRunning(["claude-agent-a"]);
    expect(repos.boxes.get("claude-agent-a")!.conversationName).toBe("orig");
    expect(published).toEqual([]);

    entry(dir, "11.json", {
      pid: 11,
      sessionId: U2,
      updatedAt: 2,
      name: "New name",
      nameSource: "user",
    });
    expect(await watcher.scan()).toEqual(["claude-agent-a"]);
    expect(repos.boxes.get("claude-agent-a")).toMatchObject({
      sessionUuid: U2,
      conversationName: "New name",
      transcriptSyncedName: "New name",
    });
    expect(published[0]).toMatchObject({
      type: "box.changed",
      boxId: "claude-agent-a",
      status: "running",
    });
  });

  it("skips desktop entries and claimed processes", async () => {
    box("claude-agent-a");
    box("claude-agent-b", { sessionUuid: U3 });
    const dir = sessionsDirFor(env, CONTAINER);
    entry(dir, "20.json", { pid: 20, sessionId: U1, updatedAt: 9, entrypoint: "claude-desktop" });
    await watcher.setRunning(["claude-agent-a"]);
    // The desktop entry is not bound, so a change to it is not followed.
    entry(dir, "20.json", { pid: 20, sessionId: U2, updatedAt: 10, entrypoint: "claude-desktop" });
    expect(await watcher.scan()).toEqual([]);
    expect(repos.boxes.get("claude-agent-a")!.sessionUuid).toBe(U1);
  });

  it("never takes a uuid another box holds", async () => {
    box("claude-agent-a");
    box("claude-agent-b", { sessionUuid: U2 });
    const dir = sessionsDirFor(env, CONTAINER);
    entry(dir, "11.json", { pid: 11, sessionId: U1, updatedAt: 1 });
    await watcher.setRunning(["claude-agent-a"]);
    entry(dir, "11.json", { pid: 11, sessionId: U2, updatedAt: 2 });
    expect(await watcher.scan()).toEqual([]);
    expect(repos.boxes.get("claude-agent-a")!.sessionUuid).toBe(U1);
  });

  it("uses the host directory for a box that is its own container", async () => {
    box("claude-agent-c", { container: "claude-agent-c", session: "main" });
    const dir = path.join(home, ".claude/sessions");
    entry(dir, "11.json", { pid: 11, sessionId: U1, updatedAt: 1 });
    await watcher.setRunning(["claude-agent-c"]);
    entry(dir, "11.json", { pid: 11, sessionId: U2, updatedAt: 2 });
    expect(await watcher.scan()).toEqual(["claude-agent-c"]);
  });

  it("forgets a stopped box", async () => {
    box("claude-agent-a");
    const dir = sessionsDirFor(env, CONTAINER);
    entry(dir, "11.json", { pid: 11, sessionId: U1, updatedAt: 1 });
    await watcher.setRunning(["claude-agent-a"]);
    await watcher.setRunning([]);
    entry(dir, "11.json", { pid: 11, sessionId: U2, updatedAt: 2 });
    expect(await watcher.scan()).toEqual([]);
  });
});

describe("file events", () => {
  it("scans after a change in a watched directory", async (ctx) => {
    box("claude-agent-a", { container: "claude-agent-a", session: "main" });
    const dir = sessionsDirFor(env, "claude-agent-a");
    fs.mkdirSync(dir, { recursive: true });
    watcher = new SessionWatcher({
      env,
      boxes: repos.boxes,
      events,
      debounceMs: 20,
      pollMs: 60_000,
    });
    watcher.start();
    await watcher.setRunning(["claude-agent-a"]);
    // The operating system can refuse a watch when the host has run out of
    // inotify instances, which happens when many test runs share a machine.
    // The server covers that case with its backstop poll, which this test
    // turns off, so there is no file event to wait for.
    if (!watcher.watchedDirs().includes(dir)) ctx.skip("The host refused the file watch.");
    entry(dir, "11.json", { pid: 11, sessionId: U2, updatedAt: 1 });
    await expect
      .poll(() => repos.boxes.get("claude-agent-a")!.sessionUuid, { timeout: 3000 })
      .toBe(U2);
  });
});
