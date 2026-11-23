// The whole server over the fake core and a fake engine on a real socket.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildSummary } from "@aio/contracts";
import { createServerIdentity, pinFromPem, pinnedFetch } from "@aio/contracts/tls";
import { startApp, type App } from "../../src/api/app.js";
import type { OpClient } from "../../src/secrets/op.js";
import { ENGINE_TOKEN, FakeEngineServer, waitFor } from "../events/fake-engine.js";
import { FakeRunner } from "../setup/fake-runner.js";
import { createFakeCore, type FakeCore } from "./fake-core.js";
import { CONTAINER, PROJECT_ID, RUN, projectSummary, runState } from "./fixtures.js";
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
  listItems: async () => [],
};

beforeEach(async () => {
  home = tempDir("aio-app-");
  engine = await new FakeEngineServer().start();
  core = createFakeCore();
  core.endpoints = [
    { container: CONTAINER, projectId: PROJECT_ID, hostPort: engine.port, token: ENGINE_TOKEN },
  ];
  runner = new FakeRunner();
  app = await startApp({
    home,
    createCore: async () => core,
    version: "1.0.0-dev",
    expectedEngineVersion: "1.0.0-dev",
    execStart: "/usr/bin/aio-server",
    imageContext: "/repo/image",
    runner,
    op,
    exec: new FakeExec(),
    port: 0,
    proxyPort: 0,
    engineIntervalMs: 50,
    log: () => undefined,
  });
});

afterEach(async () => {
  await app.close();
  await engine.stop();
});

async function api(method: string, url: string, body?: unknown) {
  const token = (
    await readFile(path.join(home, ".ai-orchestrator", "server.token"), "utf8")
  ).trim();
  const cert = await readFile(path.join(home, ".ai-orchestrator", "server.crt"), "utf8");
  const res = await pinnedFetch(() => pinFromPem(cert))(`https://127.0.0.1:${app.port}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A plain HTTP request to `port` with `host` as the `Host` header. */
function plainGet(port: number, host: string, url: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("startApp", () => {
  it("refuses a data directory too long for the broker's sockets before it writes anything", async () => {
    const dataDir = path.join(tempDir("aio-app-long-"), "d".repeat(100));
    await expect(
      startApp({
        home,
        dataDir,
        createCore: async () => core,
        version: "1.0.0-dev",
        expectedEngineVersion: "1.0.0-dev",
        execStart: "/usr/bin/aio-server",
        imageContext: "/repo/image",
        runner,
        op,
        exec: new FakeExec(),
        port: 0,
        proxyPort: 0,
        log: () => undefined,
      }),
    ).rejects.toThrow(/secrets broker socket path .* Choose a data directory/);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("serves the API with the token from the token file", async () => {
    const res = await api("GET", "/api/v1/projects");
    expect(res.status).toBe(200);
  });

  it("writes the port it listens on to server.port for the CLI", async () => {
    const written = await readFile(path.join(home, ".ai-orchestrator", "server.port"), "utf8");
    expect(written).toBe(`${app.port}\n`);
  });

  it("serves the API over HTTPS only, with the certificate in server.crt", async () => {
    await expect(plainGet(app.port, `127.0.0.1:${app.port}`, "/api/v1/health")).rejects.toThrow();
    const other = pinnedFetch(() => pinFromPem(createServerIdentity().cert));
    await expect(other(`https://127.0.0.1:${app.port}/api/v1/health`)).rejects.toThrow();
  });

  it("serves the dev-server proxy on its own plain HTTP listener", async () => {
    expect(app.proxyPort).not.toBeNull();
    const proxied = await plainGet(app.proxyPort!, "3000.nobox.localhost", "/");
    expect(proxied).toMatchObject({ status: 502 });
    expect(proxied.body).toContain("nobox");
    // The proxy listener serves no API, and the API listener no proxy.
    expect((await plainGet(app.proxyPort!, "127.0.0.1", "/api/v1/health")).status).toBe(400);
    const cert = await readFile(path.join(home, ".ai-orchestrator", "server.crt"), "utf8");
    const res = await pinnedFetch(() => pinFromPem(cert))(`https://127.0.0.1:${app.port}/`, {
      headers: { host: "3000.nobox.localhost" },
    });
    expect(res.status).toBe(404);
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

  it("stores a build, grants its calls at a ceiling, and reports its usage by seat and step", async () => {
    const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
    await waitFor(() => engine.sockets.length === 1);
    // Claude is over its ceiling, as in the test above.
    engine.emit({
      type: "usage.sample",
      vendor: "claude",
      account: "user@example.com",
      window: "5h",
      utilization: 0.7,
      spendUsd: null,
      ceiling: { kind: "utilization", window: "5h", max: 0.6 },
      resetAt: "2099-01-01T00:00:00.000Z",
      sampleSource: "rate_limit_event",
    });
    engine.emit({
      type: "build.changed",
      build: {
        id: BUILD,
        slug: "add-export",
        projectId: PROJECT_ID,
        container: CONTAINER,
        status: "running",
        step: "tasks",
        boxId: null,
        createdAt: "2026-10-28T09:00:00.000Z",
        updatedAt: "2026-10-28T09:00:00.000Z",
      },
    });
    const owner = { runId: null, buildId: BUILD, seat: "developer", step: "tasks" } as const;
    engine.sendRaw({
      type: "lease.request",
      leaseId: "B-L1",
      ...owner,
      vendor: "claude",
      role: "fixer",
      estimate: { tokens: 10 },
    });
    await waitFor(() => engine.leaseResponses.length === 1);
    expect(engine.leaseResponses[0]).toMatchObject({
      decision: "granted",
      vendor: "claude",
      redirectedFrom: null,
    });
    engine.emit({
      type: "lease.settled",
      leaseId: "B-L1",
      ...owner,
      vendor: "claude",
      role: "fixer",
      tokens: { in: 300, out: 20 },
      premiumRequests: 0,
      costEstimate: 0.5,
    });
    const types = () =>
      app.hub
        .replay({ type: "hello", streamId: app.hub.streamId, lastSeq: 0 })
        .events.map((e) => e.type);
    await waitFor(() => types().includes("lease.settled"));
    expect(types()).toEqual(expect.arrayContaining(["build.changed", "lease.settled"]));
    const usage = await api("GET", `/api/v1/builds/${BUILD}/usage`);
    expect(usage.status).toBe(200);
    const totals = {
      calls: 1,
      tokensIn: 300,
      tokensOut: 20,
      premiumRequests: 0,
      costEstimate: 0.5,
    };
    expect(usage.json).toEqual({
      buildId: BUILD,
      total: totals,
      bySeat: [{ seat: "developer", ...totals }],
      byStep: [{ step: "tasks", ...totals }],
    });
    const unknown = await api("GET", "/api/v1/builds/01JB8Z5K3W6Q2V9X4T7R0M1N2R/usage");
    expect(unknown.status).toBe(404);
  });

  it("lists builds newest first and serves a build's latest state", async () => {
    const OLD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
    const NEW = "01JB8Z5K3W6Q2V9X4T7R0M1N2R";
    await waitFor(() => engine.sockets.length === 1);
    const build = (
      id: string,
      createdAt: string,
      over: Partial<BuildSummary> = {},
    ): BuildSummary => ({
      id,
      slug: "add-export",
      projectId: PROJECT_ID,
      container: CONTAINER,
      status: "running",
      step: "tasks",
      boxId: "example-app-1",
      createdAt,
      updatedAt: createdAt,
      ...over,
    });
    engine.emit({ type: "build.changed", build: build(OLD, "2026-10-28T09:00:00.000Z") });
    engine.emit({ type: "build.changed", build: build(NEW, "2026-10-28T10:00:00.000Z") });
    engine.emit({
      type: "build.changed",
      build: build(OLD, "2026-10-28T09:00:00.000Z", {
        status: "paused",
        updatedAt: "2026-10-28T11:00:00.000Z",
      }),
    });
    const builds = () =>
      app.hub
        .replay({ type: "hello", streamId: app.hub.streamId, lastSeq: 0 })
        .events.filter((e) => e.type === "build.changed").length;
    await waitFor(() => builds() === 3);
    const paused = await api("GET", `/api/v1/builds/${OLD}`);
    expect(paused.status).toBe(200);
    expect(paused.json).toMatchObject({ id: OLD, status: "paused", boxId: "example-app-1" });
    const all = await api("GET", "/api/v1/builds");
    expect((all.json.builds as { id: string }[]).map((b) => b.id)).toEqual([NEW, OLD]);
    const mine = await api("GET", `/api/v1/builds?projectId=${PROJECT_ID}`);
    expect((mine.json.builds as unknown[]).length).toBe(2);
    const other = await api("GET", "/api/v1/builds?projectId=other-app-9f8e7d6c");
    expect(other.json.builds).toEqual([]);
    const missing = await api("GET", "/api/v1/builds/01JB8Z5K3W6Q2V9X4T7R0M1N2S");
    expect(missing.status).toBe(404);
  });

  it("clears a usage block that comes from a project's ceiling override", async () => {
    const summary = {
      ...projectSummary,
      project: {
        ...projectSummary.project,
        ceilingsOverride: { claude: { kind: "utilization", window: "5h", max: 0.4 } } as const,
      },
    };
    core.projects.list = async () => [summary];
    core.projects.get = async () => summary;
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
      utilization: 0.5,
      spendUsd: null,
      ceiling: { kind: "utilization", window: "5h", max: 0.6 },
      resetAt: "2099-01-01T00:00:00.000Z",
      source: `engine:${CONTAINER}`,
      sampleSource: "rate_limit_event",
    });
    await waitFor(() => app.hub.lastSeq >= 1);
    const request = (leaseId: string) => ({
      type: "lease.request",
      leaseId,
      runId: RUN,
      vendor: "claude",
      role: "reviewer",
      estimate: { tokens: 10 },
    });
    engine.sendRaw(request("L-1"));
    await waitFor(() => engine.leaseResponses.length === 1);
    expect(engine.leaseResponses[0]).toMatchObject({ vendor: "codex", redirectedFrom: "claude" });

    const cleared = await api("POST", "/api/v1/usage/clear", { vendor: "claude" });
    expect(cleared.json.cleared).toBe(1);

    engine.sendRaw(request("L-2"));
    await waitFor(() => engine.leaseResponses.length === 2);
    expect(engine.leaseResponses[1]).toMatchObject({ vendor: "claude", redirectedFrom: null });
  });

  it("starts an SSH tunnel for a running box's remote", async () => {
    await waitFor(() => runner.spawned.length === 1);
    expect(runner.spawned[0]!.argv[0]).toBe("ssh");
    expect(runner.spawned[0]!.argv.at(-1)).toBe("deploy@staging.example.com");
  });
});

it("startup mismatch reports upgrading and holds box starts until the image is built", async () => {
  await app.close();
  core = createFakeCore();
  const originalStatus = core.image.status;
  core.image.status = async () => ({ ...(await originalStatus()), engineMatches: false });
  for (const [id, view] of core.views) core.views.set(id, { ...view, status: "stopped" });
  core.projects.recreateContainer = async () => {};
  const root = tempDir("aio-image-");
  const imageContext = path.join(root, "image");
  mkdirSync(imageContext);
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(imageContext, "Dockerfile"), "FROM scratch");
  writeFileSync(path.join(root, "scripts", "build-image.sh"), "#!/bin/bash");
  runner = new FakeRunner();
  app = await startApp({
    home,
    createCore: async () => core,
    version: "1.0.0-dev",
    expectedEngineVersion: "1.0.0-dev",
    execStart: "/usr/bin/aio-server",
    imageContext,
    runner,
    op,
    exec: new FakeExec(),
    port: 0,
    engineIntervalMs: 50,
    log: () => {},
  });
  await waitFor(() => runner.spawned.length === 1);
  const status = await api("GET", "/api/v1/image");
  expect(status.json.upgrading).toBe(true);
  expect(status.json.buildLogJobId).toEqual(expect.any(String));
  const id = [...core.views.keys()][0]!;
  let finished = false;
  const starting = api("POST", `/api/v1/boxes/${id}/start`, { force: false }).then((result) => {
    finished = true;
    return result;
  });
  let additionalFinished = 0;
  const additional = [
    api("POST", "/api/v1/boxes/start-all", { onlyWasRunning: false }),
    api("POST", "/api/v1/boxes/restart-all"),
    api("POST", `/api/v1/boxes/${id}/restart`),
    api("POST", `/api/v1/boxes/${id}/side-sessions`, { platform: "codex" }),
    api("POST", `/api/v1/projects/${PROJECT_ID}/container/restart`),
  ].map((request) =>
    request.then((result) => {
      additionalFinished++;
      return result;
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(finished).toBe(false);
  expect(additionalFinished).toBe(0);
  runner.spawned[0]!.emit("AIO_UPGRADE_IMAGE=latest\n");
  runner.spawned[0]!.exit(0);
  expect((await starting).status).toBe(200);
  expect((await Promise.all(additional)).map((result) => result.status)).toEqual([
    200, 200, 200, 200, 200,
  ]);
  expect((await api("GET", "/api/v1/image")).json.upgrading).toBe(false);
});
