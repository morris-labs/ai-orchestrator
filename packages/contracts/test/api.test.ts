import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ApiErrorCodeSchema,
  ApiErrorSchema,
  EngineHealthSchema,
  type RouteDef,
  type RouteOf,
  buildPath,
  engineRoutes,
  pathParamNames,
  pathParamsSchema,
  routes,
  serverRoutes,
} from "../src/index.js";
import { RUN, runRequest } from "./fixtures.js";

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

  it("covers every API area the plan and the review list", () => {
    const keys = Object.keys(routes);
    const areas = [
      "auth.",
      "projects.",
      "boxes.",
      "terminals.",
      "jobs.",
      "conversations.",
      "models.",
      "image.",
      "updates.",
      "stats.",
      "setup.",
      "settings.",
      "prompts.",
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
      "attachCommand",
      "sideSessions.start",
      "sideSessions.stop",
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
    expect(keys).not.toContain("engine.leases.respond");
    expect(keys).toContain("sshRemotes.reconnect");
  });

  it("keeps every server path under /api/v1 and requires auth except for health", () => {
    for (const [key, route] of Object.entries(serverRoutes)) {
      expect(route.path.startsWith("/api/v1/") || route.path === "/api/v1", key).toBe(true);
      expect(route.auth, key).toBe(key !== "health");
    }
  });

  it("gives every WebSocket route a token query parameter", () => {
    for (const [key, route] of Object.entries(routes)) {
      if (route.kind !== "ws") continue;
      const query = route.query as { safeParse(v: unknown): { success: boolean } };
      expect(query, key).toBeDefined();
      const sample =
        key === "terminals.open" ? { kind: "session", boxId: "b", token: "t" } : { token: "t" };
      expect(query.safeParse(sample).success, key).toBe(true);
    }
  });

  it("returns a job with status 202 for creation and conversion", () => {
    for (const key of ["boxes.create", "boxes.convertToWorktree", "image.build"] as const) {
      expect(serverRoutes[key].status, key).toBe(202);
    }
  });

  it("only lists known error codes", () => {
    for (const [key, route] of Object.entries(routes)) {
      for (const code of (route as RouteDef).errors ?? [])
        expect(ApiErrorCodeSchema.safeParse(code).success, `${key} ${code}`).toBe(true);
    }
    expect(ApiErrorSchema.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(
      false,
    );
  });

  it("has codes for a failed authentication and an unexpected failure", () => {
    for (const code of ["unauthorized", "internal"]) {
      expect(ApiErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it("reports whether the engine version matches on the engine's health route", () => {
    const health = {
      version: "4.0.0",
      uptimeS: 12,
      engineVersion: "4.0.0",
      container: "claude-agent-proj-example-app-1a2b3c4d",
      projectRoot: "/home/user/src/example-app",
      streamId: "S1",
    };
    expect(EngineHealthSchema.safeParse(health).success).toBe(false);
    expect(EngineHealthSchema.parse({ ...health, versionMatches: false }).versionMatches).toBe(
      false,
    );
  });
});

describe("request schemas", () => {
  it("validates run bodies, with the run id on the engine only", () => {
    expect(routes["runs.create"].body.parse(runRequest).roundCap).toBe(25);
    expect(routes["engine.runs.create"].body.safeParse(runRequest).success).toBe(false);
    expect(routes["engine.runs.create"].body.parse({ ...runRequest, runId: RUN }).runId).toBe(RUN);
    expect(routes["runs.assign"].body.safeParse({ role: "reviewer", vendors: [] }).success).toBe(
      false,
    );
    expect(
      routes["runs.assign"].body.parse({ role: "reviewer", vendors: ["codex", "copilot"] }).vendors,
    ).toHaveLength(2);
  });

  it("requires a layout on box creation and applies the other defaults", () => {
    const body = routes["boxes.create"].body;
    expect(body.safeParse({ targetDir: "/x" }).success).toBe(false);
    expect(body.parse({ targetDir: "/x", layout: "auto" })).toMatchObject({
      platform: "claude",
      conversation: { mode: "new" },
      rememberLayout: false,
      force: false,
    });
  });

  it("enforces the platform and layout rules on box creation", () => {
    const body = routes["boxes.create"].body;
    expect(
      body.safeParse({ targetDir: "/x", layout: "root", platform: "codex", model: "m" }).success,
    ).toBe(false);
    expect(
      body.safeParse({
        targetDir: "/x",
        layout: "root",
        platform: "copilot",
        conversation: { mode: "adopt", sessionUuid: "0b9f2a7e-4c1d-4e8a-9f3b-2d6c8e1a5b70" },
      }).success,
    ).toBe(false);
    expect(body.safeParse({ targetDir: "/x", layout: "root", platform: "codex" }).success).toBe(
      true,
    );
    expect(body.safeParse({ targetDir: "/x", layout: "worktree" }).success).toBe(false);
    expect(
      body.safeParse({ targetDir: "/x", layout: "worktree", conversationName: "Fix login" })
        .success,
    ).toBe(true);
  });

  it("checks terminal and attach-command targets", () => {
    const terminal = routes["terminals.open"].query;
    expect(terminal.safeParse({ kind: "session" }).success).toBe(false);
    expect(terminal.safeParse({ kind: "side", boxId: "b" }).success).toBe(false);
    expect(terminal.safeParse({ kind: "session", boxId: "b", platform: "codex" }).success).toBe(
      false,
    );
    expect(terminal.safeParse({ kind: "shell" }).success).toBe(false);
    expect(terminal.parse({ kind: "shell", projectId: "p", cols: "120" })).toMatchObject({
      cols: 120,
      rows: 24,
    });
    const attach = routes["boxes.attachCommand"].query;
    expect(attach.safeParse({ kind: "side" }).success).toBe(false);
    expect(attach.safeParse({ kind: "side", platform: "codex" }).success).toBe(true);
  });

  it("rejects server-owned fields in a settings patch", () => {
    const body = routes["settings.patch"].body;
    expect(body.safeParse({ serverPort: 1 }).success).toBe(false);
    expect(body.safeParse({ engineImage: "claude-code" }).success).toBe(true);
  });

  it("parses query booleans as strings", () => {
    expect(routes["boxes.remove"].query.parse({}).removeWorktree).toBe(false);
    expect(routes["boxes.remove"].query.parse({ removeWorktree: "true" }).removeWorktree).toBe(
      true,
    );
    expect(routes["boxes.remove"].query.safeParse({ removeWorktree: "yes" }).success).toBe(false);
  });

  it("tests an unsaved SSH remote or the saved one", () => {
    const body = routes["sshRemotes.test"].body;
    expect(body.safeParse(undefined).success).toBe(true);
    expect(body.parse({ name: "n", host: "h" })?.forwards).toEqual([]);
  });
});

describe("path helpers", () => {
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
});

describe("RouteOf", () => {
  it("types routes", () => {
    type Get = RouteOf<"boxes.get">;
    expectTypeOf<Get["params"]>().toEqualTypeOf<{ boxId: string }>();
    expectTypeOf<Get["method"]>().toEqualTypeOf<"GET">();
    expectTypeOf<Get["response"]["box"]["platform"]>().toEqualTypeOf<
      "claude" | "codex" | "copilot"
    >();
    expectTypeOf<Get["response"]["tmuxSession"]>().toEqualTypeOf<string>();
    type Waive = RouteOf<"engine.findings.waive">;
    expectTypeOf<Waive["params"]>().toEqualTypeOf<{ runId: string; findingId: string }>();
    expectTypeOf<Waive["body"]>().toEqualTypeOf<{ reason: string }>();
    type Events = RouteOf<"events.stream">;
    expectTypeOf<Events["kind"]>().toEqualTypeOf<"ws">();
    expectTypeOf<
      Extract<Events["serverMessage"], { type: "hello" }>["streamId"]
    >().toEqualTypeOf<string>();
    type Stop = RouteOf<"boxes.sideSessions.stop">;
    expectTypeOf<Stop["params"]>().toEqualTypeOf<{ boxId: string; platform: string }>();
    type Create = RouteOf<"boxes.create">;
    expectTypeOf<Create["response"]["boxId"]>().toEqualTypeOf<string | null>();
  });
});
