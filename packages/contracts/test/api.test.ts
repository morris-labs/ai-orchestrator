import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type RouteOf,
  buildPath,
  engineRoutes,
  pathParamNames,
  pathParamsSchema,
  routes,
  serverRoutes,
} from "../src/index.js";
import { runRequest } from "./fixtures.js";

describe("route catalog", () => {
  it("has no two routes with one method and path in the same API", () => {
    for (const table of [serverRoutes, engineRoutes]) {
      const seen = new Set<string>();
      for (const route of Object.values(table)) {
        const key = `${route.method} ${route.path}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });

  it("covers every API area the plan lists", () => {
    const keys = Object.keys(routes);
    const areas = [
      "projects.",
      "boxes.",
      "terminals.",
      "conversations.",
      "models.",
      "image.",
      "setup.",
      "sshRemotes.",
      "globalMounts.",
      "secrets.",
      "runs.",
      "findings.",
      "usage.",
      "notifications.",
      "events.",
      "engine.repos.",
      "engine.runs.",
      "engine.findings.",
      "engine.usage.",
      "engine.ports",
      "engine.proxy",
      "engine.health",
      "engine.events",
    ];
    for (const area of areas)
      expect(
        keys.some((k) => k.startsWith(area)),
        area,
      ).toBe(true);
    for (const action of [
      "create",
      "start",
      "stop",
      "restart",
      "remove",
      "purge",
      "move",
      "relink",
      "convertToWorktree",
      "sideSessions.start",
      "platform",
    ]) {
      expect(keys, action).toContain(`boxes.${action}`);
    }
    for (const action of [
      "create",
      "pause",
      "resume",
      "cancel",
      "profile",
      "assign",
      "rebaseBase",
      "decide",
    ]) {
      expect(keys, action).toContain(`engine.runs.${action}`);
    }
  });

  it("keeps every server path under /api/v1 and requires auth except for health", () => {
    for (const [key, route] of Object.entries(serverRoutes)) {
      expect(route.path.startsWith("/api/v1/") || route.path === "/api/v1", key).toBe(true);
      expect(route.auth, key).toBe(key !== "health");
    }
  });

  it("validates bodies through the table", () => {
    const parsed = routes["engine.runs.create"].body.parse(runRequest);
    expect(parsed.roundCap).toBe(25);
    expect(routes["boxes.create"].body.parse({ targetDir: "/x" })).toMatchObject({
      platform: "claude",
      layout: "root",
      conversation: { mode: "new" },
    });
    expect(routes["boxes.remove"].query.parse({}).removeWorktree).toBe(false);
    expect(routes["boxes.remove"].query.parse({ removeWorktree: "true" }).removeWorktree).toBe(
      true,
    );
  });

  it("builds and lists path parameters", () => {
    const path = routes["findings.get"].path;
    expect(pathParamNames(path)).toEqual(["runId", "findingId"]);
    expect(buildPath(path, { runId: "R 1", findingId: "F-0001" })).toBe(
      "/api/v1/runs/R%201/findings/F-0001",
    );
    expect(pathParamsSchema(routes["engine.proxy"].path).parse({ port: "5173" })).toEqual({
      port: "5173",
    });
    expect(() => buildPath("/a/:b" as string, {} as never)).toThrow(/Missing path parameter/);
  });

  it("types routes with RouteOf", () => {
    type Get = RouteOf<"boxes.get">;
    expectTypeOf<Get["params"]>().toEqualTypeOf<{ boxId: string }>();
    expectTypeOf<Get["method"]>().toEqualTypeOf<"GET">();
    expectTypeOf<Get["response"]["box"]["platform"]>().toEqualTypeOf<
      "claude" | "codex" | "copilot"
    >();
    type Waive = RouteOf<"engine.findings.waive">;
    expectTypeOf<Waive["params"]>().toEqualTypeOf<{ runId: string; findingId: string }>();
    expectTypeOf<Waive["body"]>().toEqualTypeOf<{ reason: string }>();
    type Events = RouteOf<"events.stream">;
    expectTypeOf<Events["serverMessage"]["seq"]>().toEqualTypeOf<number>();
    expectTypeOf<Events["kind"]>().toEqualTypeOf<"ws">();
  });
});
