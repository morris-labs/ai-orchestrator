// A box stop pauses the box's running build, and a box start resumes the
// build that the stop paused, through the engine that runs it.
import type { AioEvent, BuildState, BuildSummary } from "@aio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { BoxBuildLink, buildSummaryOf } from "../../src/events/build-control.js";
import { ApiError } from "../../src/api/errors.js";
import { FakeEngine, FakeEngines } from "../api/harness.js";

const T = "2026-11-23T09:00:00.000Z";
const CONTAINER = "aio-agent-proj-shop";

function summary(over: Partial<BuildSummary>): BuildSummary {
  return {
    id: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q",
    slug: "cart-total",
    projectId: "proj-shop",
    container: CONTAINER,
    status: "running",
    step: "tasks",
    boxId: "box-a",
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function stateOf(build: BuildSummary, status: BuildState["status"]): BuildState {
  return {
    version: 1,
    id: build.id,
    slug: build.slug,
    projectId: build.projectId,
    boxId: build.boxId,
    container: build.container,
    title: "Add a total to the cart",
    repoPath: "/work/shop",
    base: "0123456789abcdef0123456789abcdef01234567",
    branch: `build/${build.slug}`,
    worktree: `/work/shop/.worktrees/build-${build.slug}`,
    status,
    step: "tasks",
    tasks: [],
    escalations: [],
    placements: { singleVendor: null, plan: {}, live: [] },
    createdAt: T,
    updatedAt: T,
  };
}

function boxEvent(boxId: string, status: "running" | "stopped"): AioEvent {
  return {
    type: "box.changed",
    boxId,
    status,
    box: null,
    id: "e1",
    time: T,
    source: "server",
    streamId: "s",
    seq: 1,
  } as unknown as AioEvent;
}

const links: BoxBuildLink[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.close();
});

function world(builds: BuildSummary[], engineUp = true) {
  const engine = new FakeEngine(
    { container: CONTAINER, projectId: "proj-shop" },
    {
      "engine.builds.pause": (i) => {
        const build = builds.find((b) => b.slug === i.params?.slug) as BuildSummary;
        return stateOf(build, "paused");
      },
      "engine.builds.resume": (i) => {
        const build = builds.find((b) => b.slug === i.params?.slug) as BuildSummary;
        if (build.slug === "owner-paused") {
          throw new ApiError("invalid_state", "The owner paused it.");
        }
        return stateOf(build, "running");
      },
    },
  );
  const engines = new FakeEngines(engineUp ? [engine] : []);
  const logs: string[] = [];
  const link = new BoxBuildLink({
    builds: { list: () => builds },
    engines,
    log: (m) => logs.push(m),
    retryMs: 20,
  });
  links.push(link);
  return { engine, engines, link, logs };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
}

describe("the box build link", () => {
  it("pauses the box's running build for a box stop, and leaves other boxes' builds alone", async () => {
    const { engine, link } = world([
      summary({}),
      summary({ id: "01JB8Z5K3W6Q2V9X4T7R0M1N2R", slug: "cart-tax", boxId: "box-b" }),
    ]);
    link.ingest(boxEvent("box-a", "stopped"));
    await until(() => engine.calls.length === 1);
    expect(engine.calls[0]).toEqual({
      key: "engine.builds.pause",
      input: { params: { slug: "cart-total" }, body: { reason: "box" } },
    });
  });

  it("asks the engine to hold a paused build for a box stop, such as one that waits for a limit reset", async () => {
    const { engine, link } = world([
      summary({ status: "paused" }),
      summary({ id: "01JB8Z5K3W6Q2V9X4T7R0M1N2S", slug: "done", status: "finished" }),
    ]);
    link.ingest(boxEvent("box-a", "stopped"));
    await until(() => engine.calls.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.calls.map((c) => [c.key, c.input.params?.slug])).toEqual([
      ["engine.builds.pause", "cart-total"],
    ]);
  });

  it("pauses a build that waits for an escalation for a box stop, so a resolution doesn't run work in a stopped box", async () => {
    const { engine, link } = world([summary({ status: "waiting_escalation" })]);
    link.ingest(boxEvent("box-a", "stopped"));
    await until(() => engine.calls.length === 1);
    expect(engine.calls[0]).toMatchObject({
      key: "engine.builds.pause",
      input: { params: { slug: "cart-total" }, body: { reason: "box" } },
    });
  });

  it("resumes the box's paused build for a box start, and stays quiet when the owner paused it", async () => {
    const { engine, link, logs } = world([
      summary({ status: "paused" }),
      summary({ id: "01JB8Z5K3W6Q2V9X4T7R0M1N2R", slug: "owner-paused", status: "paused" }),
      summary({ id: "01JB8Z5K3W6Q2V9X4T7R0M1N2S", slug: "done", status: "finished" }),
    ]);
    link.ingest(boxEvent("box-a", "running"));
    await until(() => engine.calls.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.calls.map((c) => [c.key, c.input.params?.slug, c.input.body])).toEqual([
      ["engine.builds.resume", "cart-total", { reason: "box" }],
      ["engine.builds.resume", "owner-paused", { reason: "box" }],
    ]);
    expect(logs).toEqual([]);
  });

  it("asks again once the engine of a starting container answers", async () => {
    const { engine, engines, link } = world([summary({ status: "paused" })], false);
    link.ingest(boxEvent("box-a", "running"));
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.calls).toEqual([]);
    engines.engines.push(engine);
    await until(() => engine.calls.length === 1);
    expect(engine.calls[0]?.key).toBe("engine.builds.resume");
  });
});

describe("the build requests", () => {
  const ID = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";

  it("cancels a build through the engine that runs it and answers its summary", async () => {
    const { createHarness, AUTH } = await import("../api/harness.js");
    const h = await createHarness();
    try {
      const res = await h.server.app.inject({
        method: "POST",
        url: `/api/v1/builds/${ID}/cancel`,
        headers: AUTH,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ id: ID, slug: "add-export", status: "cancelled" });
      expect(h.engine.calls.at(-1)).toEqual({
        key: "engine.builds.cancel",
        input: { params: { slug: "add-export" } },
      });

      const paused = await h.server.app.inject({
        method: "POST",
        url: `/api/v1/builds/${ID}/pause`,
        headers: AUTH,
      });
      expect(paused.json()).toMatchObject({ status: "paused" });
      expect(h.engine.calls.at(-1)?.input.body).toEqual({ reason: "owner" });

      const deleted = await h.server.app.inject({
        method: "DELETE",
        url: `/api/v1/builds/${ID}`,
        headers: AUTH,
      });
      expect(deleted.statusCode).toBe(200);
      expect(h.engine.calls.at(-1)?.key).toBe("engine.builds.delete");
    } finally {
      await h.server.close();
    }
  });

  it("resolves an escalation as the owner through the engine that runs the build", async () => {
    const { createHarness, AUTH } = await import("../api/harness.js");
    const h = await createHarness();
    try {
      const res = await h.server.app.inject({
        method: "POST",
        url: `/api/v1/builds/${ID}/resolve`,
        headers: AUTH,
        payload: { escalation: "E1", action: "clarify", by: "owner", note: "Use whole dollars." },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ id: ID, slug: "add-export", status: "running" });
      expect(h.engine.calls.at(-1)).toEqual({
        key: "engine.builds.resolve",
        input: {
          params: { slug: "add-export" },
          body: {
            escalation: "E1",
            action: "clarify",
            by: "owner",
            note: "Use whole dollars.",
            changes: [],
          },
        },
      });

      const missing = await h.server.app.inject({
        method: "POST",
        url: `/api/v1/builds/${ID}/resolve`,
        headers: AUTH,
        payload: { escalation: "E1", action: "clarify", by: "owner" },
      });
      expect(missing.statusCode).toBe(400);
    } finally {
      await h.server.close();
    }
  });

  it("answers not_found for a build the server hasn't seen", async () => {
    const { createHarness, AUTH } = await import("../api/harness.js");
    const h = await createHarness();
    try {
      const res = await h.server.app.inject({
        method: "POST",
        url: "/api/v1/builds/01JB8Z5K3W6Q2V9X4T7R0M1N9Z/cancel",
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
      expect(h.engine.calls).toEqual([]);
    } finally {
      await h.server.close();
    }
  });
});

describe("a build's summary", () => {
  it("carries the delete time of the build's state", () => {
    const deleted = { ...stateOf(summary({}), "cancelled"), deletedAt: "2026-11-23T10:00:00.000Z" };
    expect(buildSummaryOf(deleted)).toMatchObject({ deletedAt: "2026-11-23T10:00:00.000Z" });
    expect(buildSummaryOf(stateOf(summary({}), "running"))).not.toHaveProperty("deletedAt");
  });
});
