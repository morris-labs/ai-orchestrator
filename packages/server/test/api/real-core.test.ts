// The whole server over the real core (`createCore()` in `src/core.ts`) and
// the in-memory Docker double: the reconciliation of the API's `Core`
// interface with the core modules.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoxViewSchema, ProjectSummarySchema } from "@agentbox/contracts";
import { pinFromPem, pinnedFetch } from "@agentbox/contracts/tls";
import { startApp, type App } from "../../src/api/app.js";
import { createCore } from "../../src/core.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import { waitFor } from "../events/fake-engine.js";
import { FakeRunner } from "../setup/fake-runner.js";
import { FakeExec } from "./harness.js";
import { tempDir } from "../tmp.js";

const ENGINE_VERSION = "4.0.0-test";

type Body = Record<string, unknown>;

/** The error code of a failed response. */
const codeOf = (body: Body) => (body.error as { code: string }).code;

let app: App | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(docker: MemoryDocker) {
  const home = fs.realpathSync(tempDir("agentbox-real-"));
  const logs: string[] = [];
  let real: Awaited<ReturnType<typeof createCore>> | null = null;
  app = await startApp({
    home,
    createCore: async (options) => {
      real = await createCore({ ...options, docker, start: { pollMs: 0, watch: false } });
      return real;
    },
    version: ENGINE_VERSION,
    expectedEngineVersion: ENGINE_VERSION,
    execStart: "/usr/bin/agentbox-server",
    imageContext: path.join(home, "image"),
    runner: new FakeRunner(),
    op: {
      status: async () => ({ installed: false, version: null, signedIn: false, mode: "none" }),
      read: async () => "",
    },
    exec: new FakeExec(),
    port: 0,
    engineIntervalMs: 50,
    log: (m) => logs.push(m),
  });
  const token = fs.readFileSync(path.join(home, ".claude-box", "server.token"), "utf8").trim();
  const fetchPinned = pinnedFetch(() =>
    pinFromPem(fs.readFileSync(path.join(home, ".claude-box", "server.crt"), "utf8")),
  );
  async function api(method: string, url: string, body?: unknown) {
    const res = await fetchPinned(`https://127.0.0.1:${app!.port}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Body };
  }
  return { home, logs, api, server: () => real!.server };
}

function dockerWithImage(): MemoryDocker {
  const docker = new MemoryDocker();
  docker.addImage("claude-code", { "agentbox.engine-version": ENGINE_VERSION });
  return docker;
}

describe("the server over the real core", () => {
  it("creates, lists, and previews a purge of a box", async () => {
    const docker = dockerWithImage();
    const { home, api } = await start(docker);
    const dir = path.join(home, "work", "app");
    fs.mkdirSync(dir, { recursive: true });

    expect((await api("GET", "/api/v1/boxes")).json).toEqual({ boxes: [] });
    const listing = await api("GET", "/api/v1/fs/dirs");
    expect((listing.json.entries as { name: string }[]).map((e) => e.name)).toContain("work");

    const created = await api("POST", "/api/v1/boxes", { targetDir: dir, layout: "root" });
    expect(created.status).toBe(202);
    let job = created.json;
    for (let i = 0; i < 100 && job.status !== "finished" && job.status !== "failed"; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      job = (await api("GET", `/api/v1/jobs/${created.json.id}`)).json;
    }
    expect(job).toMatchObject({ status: "finished", exitCode: 0 });

    const boxes = (await api("GET", "/api/v1/boxes")).json.boxes as unknown[];
    expect(boxes).toHaveLength(1);
    const view = BoxViewSchema.parse(boxes[0]);
    expect(view).toMatchObject({ status: "running", targetDirExists: true });

    const projects = (await api("GET", "/api/v1/projects")).json.projects as unknown[];
    expect(ProjectSummarySchema.parse(projects[0])).toMatchObject({ running: 1, total: 1 });

    const purge = await api("POST", `/api/v1/boxes/${view.box.id}/purge`, { dryRun: true });
    expect(purge.status).toBe(409);
    expect(codeOf(purge.json)).toBe("box_running");

    const plan = await api("POST", `/api/v1/boxes/${view.box.id}/convert-to-worktree/plan`);
    expect(codeOf(plan.json)).toBe("box_running");

    const imported = await api("POST", "/api/v1/import", { dryRun: true });
    expect(imported.json).toMatchObject({ dryRun: true, boxes: 0, settingsApplied: false });

    const refused = await api("POST", "/api/v1/boxes", {
      targetDir: path.join(dir, "missing"),
      layout: "root",
    });
    expect(refused.status).toBe(400);
  });

  it("relays core events and notifies a session that ends on its own", async () => {
    const docker = dockerWithImage();
    const { home, api, server } = await start(docker);
    const dir = path.join(home, "app");
    fs.mkdirSync(dir);
    const box = await server().boxes.create({ targetDir: dir, layout: "root" });
    await server().monitor.poll();
    docker.endSession(box.container, box.session);
    await server().monitor.poll();
    await waitFor(() => app!.hub.lastSeq > 0);
    const events = app!.hub.replay({
      type: "hello",
      streamId: app!.hub.streamId,
      lastSeq: 0,
    }).events;
    expect(events.some((e) => e.type === "box.changed" && e.boxId === box.id)).toBe(true);
    expect(events.some((e) => e.type === "terminal.ended" && e.unexpected)).toBe(true);
    const list = await api("GET", "/api/v1/notifications");
    expect(list.json.notifications).toEqual([
      expect.objectContaining({ kind: "box_ended", boxId: box.id }),
    ]);
  });

  it("starts when Docker is unreachable and says so", async () => {
    const docker = dockerWithImage();
    docker.available = false;
    const { logs, api } = await start(docker);
    expect(logs.some((l) => l.includes("Docker is unreachable"))).toBe(true);
    expect((await api("GET", "/api/v1/health")).status).toBe(200);
    expect((await api("GET", "/api/v1/boxes")).json).toEqual({ boxes: [] });
  });
});
