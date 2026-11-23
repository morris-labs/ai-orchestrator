// The build socket: build requests only, scoped to the engine's project.
import http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_SOCKET_ROUTES } from "@aio/contracts";
import { serveBuildSocket, type BuildSocketServer } from "../../src/build-socket/server.js";
import { silentLogger } from "../../src/main/logger.js";
import {
  buildState,
  decision,
  directMessage,
  fakeBuildManager,
  ownerPost,
} from "../api/fixtures.js";
import { tempDir } from "../tmp.js";
import { PLAN, send } from "./helpers.js";

let server: BuildSocketServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function open(projectId: string | null = "proj-1") {
  const builds = fakeBuildManager();
  const path = join(tempDir("aio-bs-"), "build.sock");
  server = await serveBuildSocket({ path, builds, projectId, log: silentLogger });
  return { builds, path };
}

describe("the build socket", () => {
  it("starts a build with the project, box, slug, and plan of the request", async () => {
    const { builds, path } = await open();
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES.start, {
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      plan: PLAN,
    });
    expect(res.status).toBe(201);
    expect(res.body.build.slug).toBe("cart-total");
    expect(builds.start).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", boxId: "box-1", slug: "cart-total" }),
    );
    expect(builds.start.mock.calls[0]![0]).not.toHaveProperty("repoPath");
  });

  it("reads, pauses, and resumes a build", async () => {
    const { builds, path } = await open();
    const ask = { projectId: "proj-1", boxId: null, slug: "cart-total" };
    const status = await send(path, "POST", BUILD_SOCKET_ROUTES.status, ask);
    expect(status).toMatchObject({ status: 200, body: { build: { status: "running" } } });
    const paused = await send(path, "POST", BUILD_SOCKET_ROUTES.pause, ask);
    expect(paused).toMatchObject({ status: 200, body: { build: { status: "paused" } } });
    expect(builds.pause).toHaveBeenCalledWith("cart-total", "owner");
    const resumed = await send(path, "POST", BUILD_SOCKET_ROUTES.resume, ask);
    expect(resumed.status).toBe(200);
    expect(builds.resume).toHaveBeenCalledWith("cart-total", "owner");
  });

  it("cancels a build", async () => {
    const { builds, path } = await open();
    const ask = { projectId: "proj-1", boxId: null, slug: "cart-total" };
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES.cancel, ask);
    expect(res).toMatchObject({ status: 200, body: { build: { status: "cancelled" } } });
    expect(builds.cancel).toHaveBeenCalledWith("cart-total");
  });

  it("lets only the build's own box pause, resume, or cancel it", async () => {
    const { builds, path } = await open();
    builds.get.mockResolvedValue({ ...buildState, boxId: "box-1" });
    const other = { projectId: "proj-1", boxId: "box-2", slug: "cart-total" };
    for (const kind of ["pause", "resume", "cancel"] as const) {
      const res = await send(path, "POST", BUILD_SOCKET_ROUTES[kind], other);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: "conflict",
        message: expect.stringContaining("box-1"),
      });
    }
    // A session outside any box is another box too.
    const outside = await send(path, "POST", BUILD_SOCKET_ROUTES.pause, {
      ...other,
      boxId: null,
    });
    expect(outside.status).toBe(409);
    expect(builds.pause).not.toHaveBeenCalled();
    expect(builds.resume).not.toHaveBeenCalled();
    expect(builds.cancel).not.toHaveBeenCalled();
    // Any box can read it.
    expect((await send(path, "POST", BUILD_SOCKET_ROUTES.status, other)).status).toBe(200);
    // Its own box controls it.
    const own = await send(path, "POST", BUILD_SOCKET_ROUTES.pause, { ...other, boxId: "box-1" });
    expect(own.status).toBe(200);
  });

  it("resolves an escalation of a build", async () => {
    const { builds, path } = await open();
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES.resolve, {
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      escalation: "E1",
      action: "reorder",
      order: ["T2", "T1"],
      note: "Run the discount first.",
    });
    expect(res).toMatchObject({ status: 200, body: { build: { slug: "cart-total" } } });
    expect(builds.resolve).toHaveBeenCalledWith("cart-total", {
      escalation: "E1",
      action: "reorder",
      by: "project_manager",
      order: ["T2", "T1"],
      note: "Run the discount first.",
      changes: [],
    });
    const bad = await send(path, "POST", BUILD_SOCKET_ROUTES.resolve, {
      projectId: "proj-1",
      boxId: null,
      slug: "cart-total",
      escalation: "E1",
      action: "clarify",
    });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: "validation" } } });
    const foreign = await send(path, "POST", BUILD_SOCKET_ROUTES.resolve, {
      projectId: "proj-2",
      boxId: null,
      slug: "cart-total",
      escalation: "E1",
      action: "retry",
    });
    expect(foreign.status).toBe(404);
    expect(builds.resolve).toHaveBeenCalledTimes(1);
  });

  it("lets only the build's own box resolve its escalations", async () => {
    const { builds, path } = await open();
    builds.get.mockResolvedValue({ ...buildState, boxId: "box-1" });
    const ask = { projectId: "proj-1", slug: "cart-total", escalation: "E1", action: "retry" };
    const other = await send(path, "POST", BUILD_SOCKET_ROUTES.resolve, { ...ask, boxId: "box-2" });
    expect(other).toMatchObject({
      status: 409,
      body: { error: { code: "conflict", message: expect.stringContaining("box-1") } },
    });
    expect(builds.resolve).not.toHaveBeenCalled();
    const own = await send(path, "POST", BUILD_SOCKET_ROUTES.resolve, { ...ask, boxId: "box-1" });
    expect(own.status).toBe(200);
  });

  it("lets the Project manager read the direct messages and the decisions", async () => {
    const { builds, path } = await open();
    const ask = { projectId: "proj-1", boxId: "box-1", slug: "cart-total" };
    const direct = await send(path, "POST", BUILD_SOCKET_ROUTES.messages, { ...ask, direct: true });
    expect(direct.status).toBe(200);
    expect(direct.body).toEqual({ messages: [directMessage] });
    expect(builds.messages).toHaveBeenCalledWith("cart-total", { direct: true });
    const all = await send(path, "POST", BUILD_SOCKET_ROUTES.messages, ask);
    expect(all.body).toEqual({ messages: [directMessage, ownerPost] });
    const decisions = await send(path, "POST", BUILD_SOCKET_ROUTES.decisions, ask);
    expect(decisions).toMatchObject({ status: 200, body: { decisions: [decision] } });
    const other = await send(path, "POST", BUILD_SOCKET_ROUTES.messages, {
      ...ask,
      projectId: "proj-2",
    });
    expect(other.status).toBe(404);
    const unknown = await send(path, "POST", BUILD_SOCKET_ROUTES.decisions, {
      ...ask,
      slug: "no-such-build",
    });
    expect(unknown.status).toBe(404);
  });

  it("calls a planning seat and answers with the seat's answer", async () => {
    const { builds, path } = await open();
    const request = {
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      seat: "analyst",
      brief: "Add a total to the cart.",
      issue: { repository: "example/shop", number: 42 },
    };
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES.plan, request);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ call: { seat: "analyst" }, answer: { size: "small" } });
    expect(builds.plan).toHaveBeenCalledWith({
      ...request,
      issue: { ...request.issue, url: "https://github.com/example/shop/issues/42" },
    });
  });

  it("freezes a build plan and answers with the frozen version", async () => {
    const { builds, path } = await open();
    const request = { projectId: "proj-1", boxId: null, slug: "cart-total", push: true };
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES.freeze, request);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ frozen: { version: 1, push: true } });
    expect(builds.freeze).toHaveBeenCalledWith(request);
  });

  it("opens a meeting and answers when it ends", async () => {
    const { builds, path } = await open();
    const request = {
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      brief: "Attack the design.",
    };
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES.meet, request);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ meeting: { id: "meeting-1", status: "round_cap" } });
    expect(builds.meet).toHaveBeenCalledWith({
      ...request,
      proposer: "architect",
      members: ["critic"],
      rounds: 3,
    });
  });

  it("relays an owner post to a meeting", async () => {
    const { builds, path } = await open();
    const request = {
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      meeting: "meeting-1",
      body: "Keep the total in cents.",
    };
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES["meeting-post"], request);
    expect(res.status).toBe(200);
    expect(builds.meetingPost).toHaveBeenCalledWith(request);
  });

  it("refuses planning requests for another project", async () => {
    const { builds, path } = await open("proj-1");
    const ask = { projectId: "proj-2", boxId: null, slug: "cart-total" };
    const plan = await send(path, "POST", BUILD_SOCKET_ROUTES.plan, {
      ...ask,
      seat: "analyst",
      brief: "Add a total.",
    });
    const freeze = await send(path, "POST", BUILD_SOCKET_ROUTES.freeze, ask);
    const meet = await send(path, "POST", BUILD_SOCKET_ROUTES.meet, { ...ask, brief: "Attack." });
    const post = await send(path, "POST", BUILD_SOCKET_ROUTES["meeting-post"], {
      ...ask,
      meeting: "meeting-1",
      body: "Cents.",
    });
    for (const res of [plan, freeze, meet, post]) {
      expect(res).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    }
    expect(builds.plan).not.toHaveBeenCalled();
    expect(builds.freeze).not.toHaveBeenCalled();
    expect(builds.meet).not.toHaveBeenCalled();
    expect(builds.meetingPost).not.toHaveBeenCalled();
  });

  it("answers not_found for a build the engine doesn't have", async () => {
    const { path } = await open();
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES.status, {
      projectId: "proj-1",
      boxId: null,
      slug: "no-such-build",
    });
    expect(res).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  });

  it("refuses every request that isn't a build request, even with the engine token", async () => {
    const { builds, path } = await open();
    const auth = { authorization: "Bearer engine-token-0123456789" };
    const refused = [
      await send(path, "GET", "/api/v1/health", undefined, auth),
      await send(path, "POST", "/api/v1/runs", { projectId: "proj-1" }, auth),
      await send(path, "GET", "/api/v1/builds/cart-total", undefined, auth),
      await send(path, "GET", BUILD_SOCKET_ROUTES.status),
      await send(path, "DELETE", BUILD_SOCKET_ROUTES.pause),
      await send(path, "POST", `${BUILD_SOCKET_ROUTES.start}/../../runs`, {}),
    ];
    for (const res of refused) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error.message).toMatch(/only build requests/);
    }
    for (const fn of Object.values(builds)) expect(fn).not.toHaveBeenCalled();
  });

  it("refuses a malformed body or unknown fields", async () => {
    const { builds, path } = await open();
    const extra = await send(path, "POST", BUILD_SOCKET_ROUTES.start, {
      projectId: "proj-1",
      boxId: null,
      slug: "cart-total",
      plan: PLAN,
      repoPath: "/etc",
    });
    expect(extra).toMatchObject({ status: 400, body: { error: { code: "validation" } } });
    const missing = await send(path, "POST", BUILD_SOCKET_ROUTES.status, { slug: "cart-total" });
    expect(missing).toMatchObject({ status: 400, body: { error: { code: "validation" } } });
    const notJson = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { socketPath: path, method: "POST", path: BUILD_SOCKET_ROUTES.status, agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{not json");
    });
    expect(notJson).toBe(400);
    expect(builds.start).not.toHaveBeenCalled();
  });

  it("keeps a session in one project away from another project's builds", async () => {
    const { builds, path } = await open("proj-1");
    for (const route of [
      BUILD_SOCKET_ROUTES.status,
      BUILD_SOCKET_ROUTES.pause,
      BUILD_SOCKET_ROUTES.resume,
    ]) {
      const res = await send(path, "POST", route, {
        projectId: "proj-2",
        boxId: null,
        slug: "cart-total",
      });
      expect(res).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    }
    const start = await send(path, "POST", BUILD_SOCKET_ROUTES.start, {
      projectId: "proj-2",
      boxId: null,
      slug: "other",
      plan: PLAN,
    });
    expect(start).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(builds.start).not.toHaveBeenCalled();
    expect(builds.pause).not.toHaveBeenCalled();
    expect(builds.resume).not.toHaveBeenCalled();
  });

  it("checks the build's own project when the engine doesn't know its project", async () => {
    const { builds, path } = await open(null);
    const other = await send(path, "POST", BUILD_SOCKET_ROUTES.pause, {
      projectId: "proj-2",
      boxId: null,
      slug: buildState.slug,
    });
    expect(other.status).toBe(404);
    expect(builds.pause).not.toHaveBeenCalled();
    const own = await send(path, "POST", BUILD_SOCKET_ROUTES.pause, {
      projectId: buildState.projectId,
      boxId: null,
      slug: buildState.slug,
    });
    expect(own.status).toBe(200);
  });

  it("maps a conflict from the build manager to its status", async () => {
    const { builds, path } = await open();
    const { EngineError } = await import("../../src/api/core-interface.js");
    builds.start.mockRejectedValueOnce(new EngineError("conflict", "A build named x exists."));
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES.start, {
      projectId: "proj-1",
      boxId: null,
      slug: "cart-total",
      plan: PLAN,
    });
    expect(res).toMatchObject({
      status: 409,
      body: { error: { code: "conflict", message: "A build named x exists." } },
    });
  });

  it("replaces a stale socket file and removes the socket on close", async () => {
    const { existsSync, writeFileSync } = await import("node:fs");
    const path = join(tempDir("aio-bs-"), "build.sock");
    writeFileSync(path, "");
    server = await serveBuildSocket({
      path,
      builds: fakeBuildManager(),
      projectId: "proj-1",
      log: silentLogger,
    });
    const res = await send(path, "POST", BUILD_SOCKET_ROUTES.status, {
      projectId: "proj-1",
      boxId: null,
      slug: "cart-total",
    });
    expect(res.status).toBe(200);
    await server.close();
    server = null;
    expect(existsSync(path)).toBe(false);
  });
});
