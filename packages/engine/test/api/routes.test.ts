// Every engine HTTP route, through Fastify inject, against a fake core.
import { engineRoutes, type HttpRouteDef, type RouteDef } from "@aio/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError } from "../../src/api/core-interface.js";
import { buildEngineApp } from "../../src/api/server.js";
import { silentLogger } from "../../src/main/logger.js";
import {
  CONTAINER,
  PROJECT_ROOT,
  RUN,
  TOKEN,
  buildState,
  fakeBuildManager,
  fakeRunManager,
  finding,
  newBroker,
  newHub,
  runCreate,
} from "./fixtures.js";

const auth = { authorization: `Bearer ${TOKEN}` };
const listener = { port: 5173, proto: "tcp" as const, process: "node", boxId: null };

let runs: ReturnType<typeof fakeRunManager>;
let builds: ReturnType<typeof fakeBuildManager>;
let app: FastifyInstance;

async function build(expectedVersion = "1.0.0-dev") {
  const hub = newHub();
  runs = fakeRunManager();
  builds = fakeBuildManager();
  app = await buildEngineApp({
    token: TOKEN,
    container: CONTAINER,
    projectRoot: PROJECT_ROOT,
    engineVersion: "1.0.0-dev",
    expectedVersion,
    hub,
    leases: newBroker(hub),
    log: silentLogger,
    runs,
    builds,
    repos: {
      list: async () => [
        {
          path: PROJECT_ROOT,
          name: "example",
          currentBranch: "main",
          headSha: "abcdef1",
          dirty: false,
        },
      ],
      refs: async () => ({
        localBranches: ["main"],
        remoteBranches: ["origin/main"],
        tags: [],
        recentCommits: [],
        pullRequests: [],
      }),
    },
    ports: { list: () => [listener] },
  });
}

beforeEach(() => build());
afterEach(() => app.close());

interface Case {
  method: string;
  url: string;
  body?: unknown;
  status?: number;
  check?: (json: unknown) => void;
}

const base = "/api/v1/runs";
const cases: Record<string, Case> = {
  "engine.health": {
    method: "GET",
    url: "/api/v1/health",
    check: (j) =>
      expect(j).toMatchObject({
        engineVersion: "1.0.0-dev",
        streamId: "stream-1",
        versionMatches: true,
      }),
  },
  "engine.repos.list": {
    method: "GET",
    url: "/api/v1/repos",
    check: (j) => expect((j as { repos: unknown[] }).repos).toHaveLength(1),
  },
  "engine.repos.refs": {
    method: "GET",
    url: `/api/v1/repos/refs?repo=${encodeURIComponent(PROJECT_ROOT)}`,
    check: (j) => expect(j).toMatchObject({ localBranches: ["main"] }),
  },
  "engine.runs.list": {
    method: "GET",
    url: `${base}?status=running`,
    check: () => expect(runs.list).toHaveBeenCalledWith({ status: "running" }),
  },
  "engine.runs.preview": {
    method: "POST",
    url: `${base}/preview`,
    body: { projectId: "p", repoPath: PROJECT_ROOT },
    check: () =>
      expect(runs.preview).toHaveBeenCalledWith(expect.objectContaining({ base: "origin/main" })),
  },
  "engine.runs.create": {
    method: "POST",
    url: base,
    body: { runId: RUN, projectId: "p", repoPath: PROJECT_ROOT, exactBase: true },
    status: 201,
    check: () =>
      expect(runs.start).toHaveBeenCalledWith(
        expect.objectContaining({ runId: RUN, mergeBase: false }),
      ),
  },
  "engine.runs.get": {
    method: "GET",
    url: `${base}/${RUN}`,
    check: (j) => expect(j).toMatchObject({ id: RUN }),
  },
  "engine.runs.pause": {
    method: "POST",
    url: `${base}/${RUN}/pause`,
    check: (j) => expect(j).toMatchObject({ status: "paused" }),
  },
  "engine.runs.resume": {
    method: "POST",
    url: `${base}/${RUN}/resume`,
    check: () => expect(runs.resume).toHaveBeenCalledWith(RUN),
  },
  "engine.runs.cancel": {
    method: "POST",
    url: `${base}/${RUN}/cancel`,
    check: (j) => expect(j).toMatchObject({ status: "cancelled" }),
  },
  "engine.runs.profile": {
    method: "PUT",
    url: `${base}/${RUN}/profile`,
    body: { profile: "fast" },
    check: () => expect(runs.profile).toHaveBeenCalledWith(RUN, "fast"),
  },
  "engine.runs.assign": {
    method: "POST",
    url: `${base}/${RUN}/assign`,
    body: { role: "reviewer", vendors: ["codex", "claude"] },
    check: () => expect(runs.assign).toHaveBeenCalledWith(RUN, "reviewer", ["codex", "claude"]),
  },
  "engine.runs.retry": {
    method: "POST",
    url: `${base}/${RUN}/retry`,
    body: { verifyFloor: "P2" },
    check: () => expect(runs.retry).toHaveBeenCalledWith(RUN, { verifyFloor: "P2" }),
  },
  "engine.runs.rebaseBase": {
    method: "POST",
    url: `${base}/${RUN}/rebase-base`,
    check: () => expect(runs.rebaseBase).toHaveBeenCalledWith(RUN),
  },
  "engine.runs.decide": {
    method: "POST",
    url: `${base}/${RUN}/decision`,
    body: { option: "resume_waive", waiveFindingIds: ["F-0001"] },
    check: () =>
      expect(runs.decide).toHaveBeenCalledWith(RUN, {
        option: "resume_waive",
        waiveFindingIds: ["F-0001"],
      }),
  },
  "engine.runs.push": {
    method: "POST",
    url: `${base}/${RUN}/push`,
    body: {},
    check: () => expect(runs.push).toHaveBeenCalledWith(RUN, { draft: false }),
  },
  "engine.runs.groups": {
    method: "GET",
    url: `${base}/${RUN}/groups`,
    check: (j) => expect((j as { groups: unknown[] }).groups).toHaveLength(1),
  },
  "engine.runs.rounds": {
    method: "GET",
    url: `${base}/${RUN}/rounds`,
    check: (j) => expect((j as { rounds: unknown[] }).rounds).toHaveLength(1),
  },
  "engine.findings.list": {
    method: "GET",
    url: `${base}/${RUN}/findings?severity=P1&round=2`,
    check: () => expect(runs.findings).toHaveBeenCalledWith(RUN, { severity: "P1", round: 2 }),
  },
  "engine.findings.get": {
    method: "GET",
    url: `${base}/${RUN}/findings/${finding.id}`,
    check: (j) => expect(j).toMatchObject({ finding: { id: finding.id }, fixDiff: null }),
  },
  "engine.findings.waive": {
    method: "POST",
    url: `${base}/${RUN}/findings/${finding.id}/waive`,
    body: { reason: "Accepted risk" },
    check: () => expect(runs.waive).toHaveBeenCalledWith(RUN, finding.id, "Accepted risk"),
  },
  "engine.usage.samples": {
    method: "GET",
    url: "/api/v1/usage/samples?vendor=claude",
    check: () => expect(runs.usageSamples).toHaveBeenCalledWith({ vendor: "claude" }),
  },
  "engine.builds.create": {
    method: "POST",
    url: "/api/v1/builds",
    body: {
      projectId: "proj-1",
      slug: "cart-total",
      plan: {
        title: "Add a total to the cart",
        criteria: [{ id: "AC1", text: "The cart reports its total." }],
        tasks: [
          {
            id: "T1",
            title: "Cart total",
            description: "Add total().",
            ownedFiles: ["src/cart.mjs"],
            criteria: ["AC1"],
          },
        ],
        commands: { test: [{ command: "node --test" }] },
      },
    },
    status: 201,
    check: (j) => {
      expect(j).toMatchObject({ slug: "cart-total" });
      expect(builds.start).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "cart-total", projectId: "proj-1" }),
      );
    },
  },
  "engine.builds.get": {
    method: "GET",
    url: "/api/v1/builds/cart-total",
    check: (j) => expect(j).toMatchObject({ id: buildState.id, step: "tasks" }),
  },
  "engine.builds.pause": {
    method: "POST",
    url: "/api/v1/builds/cart-total/pause",
    check: (j) => {
      expect(j).toMatchObject({ status: "paused" });
      expect(builds.pause).toHaveBeenCalledWith("cart-total");
    },
  },
  "engine.builds.resume": {
    method: "POST",
    url: "/api/v1/builds/cart-total/resume",
    check: () => expect(builds.resume).toHaveBeenCalledWith("cart-total"),
  },
  "engine.builds.post": {
    method: "POST",
    url: "/api/v1/builds/cart-total/posts",
    body: { to: "developer", toTask: "T1", body: "Keep the total in whole dollars." },
    status: 201,
    check: (j) => {
      expect(j).toMatchObject({ message: { id: "M2" }, decision: { id: "D1" } });
      expect(builds.post).toHaveBeenCalledWith("cart-total", {
        to: "developer",
        toTask: "T1",
        type: "note",
        body: "Keep the total in whole dollars.",
      });
    },
  },
  "engine.ports": {
    method: "GET",
    url: "/api/v1/ports",
    check: (j) => expect(j).toEqual({ listeners: [listener] }),
  },
};

const httpRoutes = (Object.entries(engineRoutes) as [string, RouteDef][]).filter(
  (e): e is [string, HttpRouteDef] => e[1].kind === "http",
);

describe("engine HTTP routes", () => {
  it("has a test case for every HTTP route in the table", () => {
    expect(Object.keys(cases).sort()).toEqual(httpRoutes.map(([k]) => k).sort());
  });

  for (const [key, route] of httpRoutes) {
    it(`serves ${key} and returns a body that matches its schema`, async () => {
      const c = cases[key] as Case;
      expect(c.method).toBe(route.method);
      const res = await app.inject({
        method: c.method as "GET",
        url: c.url,
        headers: auth,
        ...(c.body !== undefined ? { payload: c.body as object } : {}),
      });
      expect(res.statusCode, res.body).toBe(c.status ?? route.status ?? 200);
      const json = res.json();
      expect(() => route.response.parse(json)).not.toThrow();
      c.check?.(json);
    });

    if (route.auth) {
      it(`refuses ${key} without the bearer token`, async () => {
        const c = cases[key] as Case;
        const res = await app.inject({ method: c.method as "GET", url: c.url });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
      });
    }
  }
});

describe("engine API behavior", () => {
  it("serves health without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("reports versionMatches false when the server expects another version", async () => {
    await app.close();
    await build("4.0.1");
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.json()).toMatchObject({ versionMatches: false, engineVersion: "1.0.0-dev" });
  });

  it("refuses a wrong token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/repos",
      headers: { authorization: "Bearer wrong-token-wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("answers validation for a body that doesn't match the schema", async () => {
    const res = await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { ...runCreate, runId: "not-a-ulid" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "validation" } });
    expect(runs.start).not.toHaveBeenCalled();
  });

  it("answers validation for a query that doesn't match the schema", async () => {
    const res = await app.inject({ method: "GET", url: `${base}?status=bogus`, headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it("answers validation for malformed JSON", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${base}/${RUN}/assign`,
      headers: { ...auth, "content-type": "application/json" },
      payload: "{nope",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "validation" } });
  });

  it("answers validation with 413 for a body over the size limit", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${base}/${RUN}/assign`,
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ role: "reviewer", padding: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: "validation" } });
  });

  it("accepts an empty JSON body on a route that takes none", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${base}/${RUN}/pause`,
      headers: { ...auth, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(200);
  });

  it("answers run_not_found for an unknown run", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${base}/01JB8Z5K3W6Q2V9X4T7R0M1N2Q`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "run_not_found" } });
  });

  it("answers not_found for an unknown build", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/builds/no-such", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers not_found for an unknown finding", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${base}/${RUN}/findings/F-9`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("passes a core EngineError through with its status", async () => {
    runs.pause.mockRejectedValueOnce(new EngineError("invalid_state", "The run is finished."));
    const res = await app.inject({ method: "POST", url: `${base}/${RUN}/pause`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: "invalid_state", message: "The run is finished." },
    });
  });

  it("hides an unexpected error behind a 500", async () => {
    runs.cancel.mockRejectedValueOnce(new Error("disk on fire"));
    const res = await app.inject({ method: "POST", url: `${base}/${RUN}/cancel`, headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("disk on fire");
  });

  it("refuses a core response that breaks the contract", async () => {
    runs.get.mockResolvedValueOnce({ id: RUN } as never);
    const res = await app.inject({ method: "GET", url: `${base}/${RUN}`, headers: auth });
    expect(res.statusCode).toBe(500);
  });

  it("answers not_found for an unknown path", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
