// The whole server over the fake core and a fake engine on a real socket.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApp, type App } from "../../src/api/app.js";
import type { OpClient } from "../../src/secrets/op.js";
import { ENGINE_TOKEN, FakeEngineServer, waitFor } from "../events/fake-engine.js";
import { FakeRunner } from "../setup/fake-runner.js";
import { createFakeCore, type FakeCore } from "./fake-core.js";
import { CONTAINER, PROJECT_ID, RUN, runState } from "./fixtures.js";
import { FakeExec } from "./harness.js";
import { tempDir } from "../tmp.js";

let app: App;
let engine: FakeEngineServer;
let core: FakeCore;
let home: string;
let runner: FakeRunner;

const op: OpClient = {
  status: async () => ({ installed: true, version: "2.30.0", signedIn: true, mode: "desktop" }),
  read: async () => "value",
};

beforeEach(async () => {
  home = tempDir("agentbox-app-");
  engine = await new FakeEngineServer().start();
  core = createFakeCore();
  core.endpoints = [
    { container: CONTAINER, projectId: PROJECT_ID, hostPort: engine.port, token: ENGINE_TOKEN },
  ];
  runner = new FakeRunner();
  app = await startApp({
    home,
    createCore: async () => core,
    version: "4.0.0-dev",
    expectedEngineVersion: "4.0.0-dev",
    execStart: "/usr/bin/agentbox-server",
    imageContext: "/repo/image",
    runner,
    op,
    exec: new FakeExec(),
    port: 0,
    engineIntervalMs: 50,
    log: () => undefined,
  });
});

afterEach(async () => {
  await app.close();
  await engine.stop();
});

async function api(method: string, url: string, body?: unknown) {
  const token = (await readFile(path.join(home, ".claude-box", "server.token"), "utf8")).trim();
  const res = await fetch(`http://127.0.0.1:${app.port}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("startApp", () => {
  it("serves the API with the token from the token file", async () => {
    const res = await api("GET", "/api/v1/projects");
    expect(res.status).toBe(200);
  });

  it("relays engine events, mirrors runs, and raises notifications", async () => {
    await waitFor(() => engine.sockets.length === 1);
    engine.emit({
      type: "run.changed",
      run: {
        ...runState,
        status: "waiting_decision",
        decision: {
          kind: "round_cap",
          findingIds: [],
          options: ["cancel"],
          message: "Cap reached.",
        },
      },
      roundSummary: null,
    });
    await waitFor(() => app.hub.lastSeq >= 2);
    const events = app.hub.replay({ type: "hello", streamId: app.hub.streamId, lastSeq: 0 }).events;
    expect(events[0]).toMatchObject({
      type: "run.changed",
      sourceSeq: 1,
      source: `engine:${CONTAINER}`,
    });
    expect(events.some((e) => e.type === "notification" && e.kind === "decision_needed")).toBe(
      true,
    );
    const list = await api("GET", "/api/v1/notifications?unread=true");
    expect((list.json.notifications as unknown[]).length).toBe(1);
    const run = await api("GET", `/api/v1/runs/${RUN}`);
    expect(run.status).toBe(200);
  });

  it("answers lease requests with the scheduler and records usage samples", async () => {
    await waitFor(() => engine.sockets.length === 1);
    engine.sendRaw({
      type: "usage.sample",
      id: "u1",
      time: new Date().toISOString(),
      streamId: engine.streamId,
      seq: 1,
      sourceSeq: 1,
      vendor: "claude",
      account: "user@example.com",
      window: "5h",
      utilization: 0.7,
      spendUsd: null,
      ceiling: { kind: "utilization", window: "5h", max: 0.6 },
      resetAt: "2099-01-01T00:00:00.000Z",
      source: `engine:${CONTAINER}`,
      sampleSource: "rate_limit_event",
    });
    await waitFor(() => app.hub.lastSeq >= 1);
    engine.sendRaw({
      type: "lease.request",
      leaseId: "L-1",
      runId: RUN,
      vendor: "claude",
      role: "reviewer",
      estimate: { tokens: 10 },
    });
    await waitFor(() => engine.leaseResponses.length === 1);
    expect(engine.leaseResponses[0]).toMatchObject({
      decision: "granted",
      vendor: "codex",
      redirectedFrom: "claude",
    });
    const samples = await api("GET", "/api/v1/usage/samples?vendor=claude");
    expect((samples.json.samples as unknown[]).length).toBe(1);
    const usage = await api("GET", "/api/v1/usage");
    expect(usage.json.vendors).toEqual(
      expect.arrayContaining([expect.objectContaining({ vendor: "claude", overCeiling: true })]),
    );
  });

  it("starts an SSH tunnel for a running box's remote", async () => {
    await waitFor(() => runner.spawned.length === 1);
    expect(runner.spawned[0]!.argv[0]).toBe("ssh");
    expect(runner.spawned[0]!.argv.at(-1)).toBe("deploy@staging.example.com");
  });
});
