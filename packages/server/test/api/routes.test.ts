import { RunIdSchema, projectContainerName, serverRoutes } from "@aio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionValue } from "../../src/api/auth.js";
import { failureOf } from "../../src/api/server.js";
import { HOLD_EDITS_MESSAGE } from "../../src/api/handlers.js";
import {
  AUTH,
  FakeEngine,
  TOKEN,
  createHarness,
  type FakeEngines,
  type Harness,
} from "./harness.js";
import { RUN, UUID, box, runState, sshRemote } from "./fixtures.js";

const V1 = "/api/v1";
const B = `${V1}/boxes/${box.id}`;
const P = `${V1}/projects/example-app-1a2b3c4d`;
const R = `${V1}/runs/${RUN}`;

interface Case {
  key: keyof typeof serverRoutes;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  body?: unknown;
  status: number;
  setup?: (h: Harness) => void;
}

const policy = { version: 1 };

// One successful call per HTTP route. Each response passes the route's
// response schema inside the server, or the call fails with a 500.
const cases: Case[] = [
  { key: "health", method: "GET", url: `${V1}/health`, status: 200 },
  { key: "auth.session", method: "POST", url: `${V1}/auth/session`, status: 200 },
  { key: "projects.list", method: "GET", url: `${V1}/projects`, status: 200 },
  {
    key: "projects.create",
    method: "POST",
    url: `${V1}/projects`,
    body: { root: "/work/other" },
    status: 201,
  },
  { key: "projects.get", method: "GET", url: P, status: 200 },
  { key: "projects.update", method: "PATCH", url: P, body: { name: "Renamed" }, status: 200 },
  { key: "projects.remove", method: "DELETE", url: `${P}?force=true`, status: 200 },
  { key: "projects.restartContainer", method: "POST", url: `${P}/container/restart`, status: 200 },
  { key: "projects.policy.get", method: "GET", url: `${P}/policy`, status: 200 },
  { key: "projects.policy.put", method: "PUT", url: `${P}/policy`, body: policy, status: 200 },
  { key: "projects.repos.list", method: "GET", url: `${P}/repos`, status: 200 },
  {
    key: "projects.repos.refs",
    method: "GET",
    url: `${P}/repos/refs?repo=/work/example-app`,
    status: 200,
  },
  {
    key: "boxes.list",
    method: "GET",
    url: `${V1}/boxes?projectId=example-app-1a2b3c4d`,
    status: 200,
  },
  {
    key: "boxes.create",
    method: "POST",
    url: `${V1}/boxes`,
    body: { targetDir: "/work/example-app", conversationName: "fix it", layout: "worktree" },
    status: 202,
  },
  { key: "boxes.get", method: "GET", url: B, status: 200 },
  { key: "boxes.update", method: "PATCH", url: B, body: { conversationName: "x" }, status: 200 },
  {
    key: "boxes.start",
    method: "POST",
    url: B + "/start",
    status: 200,
    setup: (h) => h.core.views.set(box.id, { ...h.core.views.get(box.id)!, status: "stopped" }),
  },
  { key: "boxes.stop", method: "POST", url: `${B}/stop`, status: 200 },
  { key: "boxes.restart", method: "POST", url: `${B}/restart`, status: 200 },
  {
    key: "boxes.remove",
    method: "DELETE",
    url: `${B}?removeWorktree=true`,
    status: 200,
    setup: (h) => h.core.views.set(box.id, { ...h.core.views.get(box.id)!, status: "stopped" }),
  },
  { key: "boxes.purge", method: "POST", url: `${B}/purge`, body: { dryRun: true }, status: 200 },
  { key: "boxes.move", method: "POST", url: `${B}/move`, body: { newDir: "/work/b" }, status: 200 },
  {
    key: "boxes.relink",
    method: "POST",
    url: `${B}/relink`,
    body: { targetDir: "/work/b" },
    status: 200,
  },
  {
    key: "boxes.convertToWorktree",
    method: "POST",
    url: `${B}/convert-to-worktree`,
    body: {},
    status: 202,
  },
  {
    key: "boxes.convertToWorktree.plan",
    method: "POST",
    url: `${B}/convert-to-worktree/plan`,
    status: 200,
  },
  {
    key: "boxes.attachCommand",
    method: "GET",
    url: `${B}/attach-command?kind=session`,
    status: 200,
  },
  {
    key: "boxes.sideSessions.start",
    method: "POST",
    url: `${B}/side-sessions`,
    body: { platform: "codex" },
    status: 200,
  },
  {
    key: "boxes.sideSessions.stop",
    method: "DELETE",
    url: `${B}/side-sessions/codex`,
    status: 200,
  },
  {
    key: "boxes.platform",
    method: "PUT",
    url: `${B}/platform`,
    body: { platform: "codex" },
    status: 200,
  },
  {
    key: "boxes.message",
    method: "POST",
    url: `${B}/message`,
    body: { text: "hello" },
    status: 200,
  },
  { key: "boxes.startAll", method: "POST", url: `${V1}/boxes/start-all`, body: {}, status: 200 },
  { key: "boxes.stopAll", method: "POST", url: `${V1}/boxes/stop-all`, status: 200 },
  { key: "boxes.restartAll", method: "POST", url: `${V1}/boxes/restart-all`, status: 200 },
  { key: "stats.refresh", method: "POST", url: `${V1}/stats/refresh`, status: 200 },
  {
    key: "jobs.get",
    method: "GET",
    url: `${V1}/jobs/JOB`,
    status: 200,
  },
  {
    key: "conversations.list",
    method: "GET",
    url: `${V1}/conversations?dir=/work/example-app`,
    status: 200,
  },
  { key: "models.list", method: "GET", url: `${V1}/models`, status: 200 },
  { key: "models.rescan", method: "POST", url: `${V1}/models/rescan`, status: 409 },
  { key: "image.status", method: "GET", url: `${V1}/image`, status: 200 },
  { key: "import.run", method: "POST", url: `${V1}/import`, body: { dryRun: true }, status: 200 },
  { key: "fs.dirs", method: "GET", url: `${V1}/fs/dirs`, status: 200 },
  {
    key: "image.build",
    method: "POST",
    url: `${V1}/image/build`,
    body: { kind: "packages" },
    status: 202,
  },
  { key: "updates.check", method: "GET", url: `${V1}/updates?force=true`, status: 200 },
  { key: "setup.get", method: "GET", url: `${V1}/setup`, status: 200 },
  { key: "setup.fix", method: "POST", url: `${V1}/setup/checks/ssh_key/fix`, status: 202 },
  {
    key: "setup.complete",
    method: "PUT",
    url: `${V1}/setup`,
    body: { defaultTargetDir: "/work" },
    status: 200,
  },
  { key: "settings.get", method: "GET", url: `${V1}/settings`, status: 200 },
  {
    key: "settings.patch",
    method: "PATCH",
    url: `${V1}/settings`,
    body: { engineImage: "x" },
    status: 200,
  },
  { key: "prompts.get", method: "GET", url: `${V1}/prompts`, status: 200 },
  {
    key: "prompts.put",
    method: "PUT",
    url: `${V1}/prompts`,
    body: { workspace: "a", worktree: "b", portHint: "", starter: "" },
    status: 200,
  },
  { key: "sshRemotes.list", method: "GET", url: `${V1}/ssh-remotes`, status: 200 },
  {
    key: "sshRemotes.put",
    method: "PUT",
    url: `${V1}/ssh-remotes/staging`,
    body: { name: "staging", host: "a@b" },
    status: 200,
  },
  { key: "sshRemotes.delete", method: "DELETE", url: `${V1}/ssh-remotes/staging`, status: 200 },
  {
    key: "sshRemotes.test",
    method: "POST",
    url: `${V1}/ssh-remotes/test`,
    body: sshRemote,
    status: 200,
  },
  {
    key: "sshRemotes.testSaved",
    method: "POST",
    url: `${V1}/ssh-remotes/staging/test`,
    status: 200,
  },
  {
    key: "sshRemotes.reconnect",
    method: "POST",
    url: `${V1}/ssh-remotes/staging/reconnect`,
    status: 200,
  },
  {
    key: "sshRemotes.copyId",
    method: "POST",
    url: `${V1}/ssh-remotes/staging/copy-id`,
    status: 202,
  },
  { key: "accounts.list", method: "GET", url: `${V1}/accounts`, status: 200 },
  {
    key: "accounts.create",
    method: "POST",
    url: `${V1}/accounts`,
    body: { vendor: "codex", name: "work" },
    status: 201,
  },
  {
    key: "accounts.seed",
    method: "POST",
    url: `${V1}/accounts/seed`,
    body: { vendors: ["claude"] },
    status: 202,
  },
  { key: "accounts.get", method: "GET", url: `${V1}/accounts/claude/work`, status: 200 },
  {
    key: "accounts.update",
    method: "PATCH",
    url: `${V1}/accounts/claude/work`,
    body: { label: "Work (Pro)", ceiling: null },
    status: 200,
  },
  { key: "accounts.remove", method: "DELETE", url: `${V1}/accounts/claude/work`, status: 200 },
  { key: "accounts.check", method: "POST", url: `${V1}/accounts/claude/work/check`, status: 200 },
  { key: "accounts.relink", method: "POST", url: `${V1}/accounts/relink`, status: 200 },
  {
    key: "transcripts.adopt",
    method: "POST",
    url: `${V1}/transcripts/adopt`,
    body: { dryRun: true },
    status: 200,
  },
  {
    key: "accounts.import",
    method: "POST",
    url: `${V1}/accounts/import`,
    body: { vendor: "codex", name: "main", from: "/data/ready" },
    status: 201,
  },
  { key: "globalMounts.get", method: "GET", url: `${V1}/global-mounts`, status: 200 },
  {
    key: "globalMounts.put",
    method: "PUT",
    url: `${V1}/global-mounts`,
    body: { mounts: [{ host: "/srv", container: "/srv" }] },
    status: 200,
  },
  { key: "secrets.get", method: "GET", url: `${V1}/secrets`, status: 200 },
  {
    key: "secrets.put",
    method: "PUT",
    url: `${V1}/secrets`,
    body: { refs: [{ name: "X", ref: "op://V/I/F" }] },
    status: 200,
  },
  { key: "secrets.available", method: "GET", url: `${V1}/secrets/available`, status: 200 },
  { key: "secrets.check", method: "POST", url: `${V1}/secrets/check`, body: {}, status: 200 },
  { key: "runs.list", method: "GET", url: `${V1}/runs?boxId=${box.id}`, status: 200 },
  {
    key: "runs.preview",
    method: "POST",
    url: `${V1}/runs/preview`,
    body: { projectId: "example-app-1a2b3c4d", repoPath: "/work/example-app" },
    status: 200,
  },
  {
    key: "runs.create",
    method: "POST",
    url: `${V1}/runs`,
    body: { projectId: "example-app-1a2b3c4d", repoPath: "/work/example-app", boxId: box.id },
    status: 201,
  },
  { key: "runs.get", method: "GET", url: R, status: 200 },
  { key: "runs.pause", method: "POST", url: `${R}/pause`, status: 200 },
  { key: "runs.resume", method: "POST", url: `${R}/resume`, status: 200 },
  { key: "runs.cancel", method: "POST", url: `${R}/cancel`, status: 200 },
  {
    key: "runs.profile",
    method: "PUT",
    url: `${R}/profile`,
    body: { profile: "fast" },
    status: 200,
  },
  {
    key: "runs.assign",
    method: "POST",
    url: `${R}/assign`,
    body: { role: "reviewer", vendors: ["codex"] },
    status: 200,
  },
  { key: "runs.rebaseBase", method: "POST", url: `${R}/rebase-base`, status: 200 },
  {
    key: "runs.decide",
    method: "POST",
    url: `${R}/decision`,
    body: { option: "resume" },
    status: 200,
  },
  { key: "runs.push", method: "POST", url: `${R}/push`, body: {}, status: 200 },
  { key: "runs.groups", method: "GET", url: `${R}/groups`, status: 200 },
  { key: "runs.rounds", method: "GET", url: `${R}/rounds`, status: 200 },
  { key: "findings.list", method: "GET", url: `${R}/findings?round=1`, status: 200 },
  { key: "findings.get", method: "GET", url: `${R}/findings/F-0001`, status: 200 },
  {
    key: "findings.waive",
    method: "POST",
    url: `${R}/findings/F-0001/waive`,
    body: { reason: "ok" },
    status: 200,
  },
  { key: "usage.samples", method: "GET", url: `${V1}/usage/samples?vendor=claude`, status: 200 },
  { key: "usage.get", method: "GET", url: `${V1}/usage`, status: 200 },
  { key: "notifications.list", method: "GET", url: `${V1}/notifications?unread=true`, status: 200 },
  { key: "notifications.read", method: "POST", url: `${V1}/notifications/n1/read`, status: 200 },
  { key: "machines.list", method: "GET", url: `${V1}/machines`, status: 200 },
  { key: "machines.enroll", method: "POST", url: `${V1}/machines/enrollment-codes`, status: 201 },
  { key: "machines.revoke", method: "DELETE", url: `${V1}/machines/m1`, status: 200 },
  { key: "node.get", method: "GET", url: `${V1}/node`, status: 200 },
  { key: "node.health", method: "GET", url: `${V1}/node/health`, status: 200 },
  {
    key: "node.join",
    method: "POST",
    url: `${V1}/node/join`,
    body: { hubUrl: "https://hub.example.com:21402", code: "7K2Q-M9XD-4HPA-R3TB" },
    status: 200,
  },
];

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.server.close();
});

describe("route table", () => {
  it("has a case for every HTTP route", () => {
    const httpKeys = Object.entries(serverRoutes)
      .filter(([, def]) => def.kind === "http")
      .map(([k]) => k)
      .sort();
    expect(cases.map((c) => c.key).sort()).toEqual(httpKeys);
  });

  it("matches each case's method and path to the contract", () => {
    for (const c of cases) {
      const def = serverRoutes[c.key];
      expect(def.method, c.key).toBe(c.method);
      const pattern = new RegExp(`^${def.path.replace(/:[A-Za-z]+/g, "[^/]+")}(\\?.*)?$`);
      expect(c.url, c.key).toMatch(pattern);
    }
  });

  for (const c of cases) {
    it(`answers ${c.key}`, async () => {
      c.setup?.(h);
      let url = c.url;
      if (c.key === "jobs.get") {
        const job = h.jobs.start({ kind: "image_build", command: "docker build" }, async () => ({
          exitCode: 0,
        }));
        url = url.replace("JOB", job.id);
      }
      const res = await h.server.app.inject({
        method: c.method,
        url,
        headers: AUTH,
        ...(c.body === undefined ? {} : { payload: c.body as object }),
      });
      expect(res.statusCode, res.body).toBe(c.status);
    });
  }
});

describe("authentication", () => {
  it("refuses a request without the token", async () => {
    const res = await h.server.app.inject({ method: "GET", url: `${V1}/projects` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("refuses a wrong token and a query token on an HTTP route", async () => {
    const wrong = await h.server.app.inject({
      method: "GET",
      url: `${V1}/projects`,
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(401);
    const query = await h.server.app.inject({
      method: "GET",
      url: `${V1}/projects?token=${TOKEN}`,
    });
    expect(query.statusCode).toBe(401);
  });

  it("serves health without a token", async () => {
    const res = await h.server.app.inject({ method: "GET", url: `${V1}/health` });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe("1.0.0-dev");
  });

  it("sets the session cookie and accepts it afterwards", async () => {
    const res = await h.server.app.inject({
      method: "POST",
      url: `${V1}/auth/session`,
      headers: AUTH,
    });
    const cookie = res.headers["set-cookie"] as string;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain(TOKEN);
    const value = cookie.split(";")[0] as string;
    expect(value).toBe(`aio_session=${sessionValue(TOKEN)}`);
    const next = await h.server.app.inject({
      method: "GET",
      url: `${V1}/projects`,
      headers: { cookie: value },
    });
    expect(next.statusCode).toBe(200);
  });

  it("needs the bearer header, not the cookie, to set the cookie", async () => {
    const res = await h.server.app.inject({
      method: "POST",
      url: `${V1}/auth/session`,
      headers: { cookie: `aio_session=${sessionValue(TOKEN)}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("accounts", () => {
  const call = (method: Case["method"], url: string, body?: object) =>
    h.server.app.inject({ method, url, headers: AUTH, ...(body ? { payload: body } : {}) });

  it("refuses to seed while a box runs, before a job starts", async () => {
    h.core.runningBoxIds.push(box.id);
    const res = await call("POST", `${V1}/accounts/seed`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("box_running");
    expect(h.core.calls).not.toContain("accounts.seed:false");
  });

  it("runs seeding as an account_seed job with the report as its result", async () => {
    const res = await call("POST", `${V1}/accounts/seed`, { dryRun: true });
    expect(res.statusCode).toBe(202);
    expect(res.json().kind).toBe("account_seed");
    const jobId = res.json().id as string;
    let job = res.json();
    for (let i = 0; i < 50 && job.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      job = (await call("GET", `${V1}/jobs/${jobId}`)).json();
    }
    expect(job.status).toBe("finished");
    expect(job.result).toEqual({ dryRun: true, accounts: [] });
  });

  it("rejects a malformed account name", async () => {
    const res = await call("POST", `${V1}/accounts`, { vendor: "claude", name: "Bad Name" });
    expect(res.statusCode).toBe(400);
  });
});

describe("errors", () => {
  const call = (method: Case["method"], url: string, body?: object) =>
    h.server.app.inject({ method, url, headers: AUTH, ...(body ? { payload: body } : {}) });

  it("maps not_found to 404", async () => {
    const res = await call("GET", `${V1}/boxes/aio-agent-missing`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("maps box_running to 409", async () => {
    const res = await call("POST", `${B}/start`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("box_running");
  });

  it("answers adoption_refused before starting a job", async () => {
    const res = await call("POST", `${V1}/boxes`, {
      targetDir: "/work/example-app",
      layout: "root",
      conversation: { mode: "adopt", sessionUuid: UUID },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("adoption_refused");
  });

  it("rejects a body that fails its schema with 400 validation", async () => {
    const res = await call("POST", `${V1}/boxes`, { targetDir: "/x", layout: "worktree" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation");
  });

  it("names the route that owns a settings field PATCH refuses", async () => {
    const res = await call("PATCH", `${V1}/settings`, {
      secretRefs: [{ name: "GH_TOKEN", ref: "op://Vault/item/field" }],
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe("validation");
    expect(error.message).toContain("Set secretRefs with PUT /api/v1/secrets.");
  });

  it("adds no route hint for an unknown settings field", async () => {
    const res = await call("PATCH", `${V1}/settings`, { nope: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("The body doesn't match its schema.");
  });

  it("maps Fastify's own 4xx errors by status code", () => {
    const fastify = Object.assign(new Error("Body is too large"), {
      statusCode: 413,
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
    });
    expect(failureOf(fastify)).toMatchObject({ code: "validation", status: 413 });
    const coded = Object.assign(new Error("gone"), { statusCode: 400, code: "not_found" });
    expect(failureOf(coded)).toMatchObject({ code: "not_found", status: 404 });
  });

  it("rejects relative paths before acting on them", async () => {
    const relative: [Case["method"], string, object | undefined][] = [
      ["GET", `${V1}/conversations?dir=work/app`, undefined],
      ["GET", `${V1}/models?dir=work/app`, undefined],
      ["POST", `${V1}/projects`, { root: "work/other" }],
      ["PATCH", P, { primaryRepo: "./repo" }],
      ["PATCH", P, { mounts: [{ host: "data", container: "/data" }] }],
      ["PATCH", P, { mounts: [{ host: "/srv/data", container: "data" }] }],
      ["POST", `${V1}/boxes`, { targetDir: ".", conversationName: "fix it", layout: "root" }],
      ["POST", `${B}/move`, { newDir: "../b" }],
      ["POST", `${B}/relink`, { targetDir: "b" }],
      ["PUT", `${V1}/global-mounts`, { mounts: [{ host: "srv", container: "/srv" }] }],
      ["POST", `${V1}/runs/preview`, { projectId: "example-app-1a2b3c4d", repoPath: "repo" }],
      ["POST", `${V1}/runs`, { projectId: "example-app-1a2b3c4d", repoPath: "." }],
    ];
    const before = h.core.calls.length;
    for (const [method, url, body] of relative) {
      const res = await call(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(res.json().error.message).toMatch(/must be an absolute path/);
    }
    expect(h.core.calls.slice(before)).toEqual([]);
    expect(h.engine.calls.filter((c) => c.key.startsWith("engine.runs."))).toEqual([]);
  });

  it("rejects invalid JSON", async () => {
    const res = await h.server.app.inject({
      method: "POST",
      url: `${B}/message`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{nope",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a query that fails its schema", async () => {
    const res = await call("GET", `${V1}/conversations`);
    expect(res.statusCode).toBe(400);
  });

  it("answers an unknown route with not_found", async () => {
    const res = await call("GET", `${V1}/nothing`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("reports run_not_found from the engine", async () => {
    const res = await call("GET", `${V1}/runs/01JB8Z5K3W6Q2V9X4T7R0M1N2Q`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("run_not_found");
  });

  it("refuses runs on a mismatched engine", async () => {
    h.engine.mismatch = true;
    const res = await call("POST", `${V1}/runs`, {
      projectId: "example-app-1a2b3c4d",
      repoPath: "/work/example-app",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("engine_mismatch");
  });

  it("refuses an unknown side-session platform", async () => {
    const res = await call("DELETE", `${B}/side-sessions/emacs`);
    expect(res.statusCode).toBe(400);
  });

  it("fails with 500 when a handler builds an invalid response", async () => {
    h.core.models.list = async () => ({ models: [] }) as never;
    const res = await call("GET", `${V1}/models`);
    expect(res.statusCode).toBe(500);
  });
});

describe("review routes", () => {
  it("mints a ULID run id, mirrors the run, and asks the box to hold edits", async () => {
    const res = await h.server.app.inject({
      method: "POST",
      url: `${V1}/runs`,
      headers: AUTH,
      payload: { projectId: "example-app-1a2b3c4d", repoPath: "/work/example-app", boxId: box.id },
    });
    expect(res.statusCode).toBe(201);
    const run = res.json();
    expect(RunIdSchema.safeParse(run.id).success).toBe(true);
    const sent = h.engine.calls.find((c) => c.key === "engine.runs.create");
    expect((sent?.input.body as { runId: string }).runId).toBe(run.id);
    expect(h.runs.get(run.id)?.status).toBe("pending");
    expect(h.core.calls).toContain(`message:${box.id}:${HOLD_EDITS_MESSAGE.slice(0, 20)}`);
  });

  it("refuses a read-only post-push run before it reaches the engine", async () => {
    const res = await h.server.app.inject({
      method: "POST",
      url: `${V1}/runs`,
      headers: AUTH,
      payload: {
        projectId: "example-app-1a2b3c4d",
        repoPath: "/work/example-app",
        readOnly: true,
        pipeline: "post-push",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("read-only run can't use the post-push pipeline");
    expect(h.engine.calls.some((c) => c.key === "engine.runs.create")).toBe(false);
  });

  it("refuses a run whose box is in another project", async () => {
    const other = "other-app-9f8e7d6c";
    const before = h.core.calls.length;
    for (const url of [`${V1}/runs`, `${V1}/runs/preview`]) {
      const res = await h.server.app.inject({
        method: "POST",
        url,
        headers: AUTH,
        payload: { projectId: other, repoPath: "/work/other-app", boxId: box.id },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain(`belongs to project ${box.projectId}`);
    }
    expect(h.engine.calls.filter((c) => c.key.startsWith("engine.runs."))).toEqual([]);
    expect(h.core.calls.slice(before).filter((c) => c.startsWith("message:"))).toEqual([]);
  });

  it("forwards params, query, and body to the engine", async () => {
    await h.server.app.inject({
      method: "GET",
      url: `${R}/findings?verdict=fixed&round=2`,
      headers: AUTH,
    });
    const call = h.engine.calls.find((c) => c.key === "engine.findings.list");
    expect(call?.input.params).toEqual({ runId: RUN });
    expect(call?.input.query).toEqual({ verdict: "fixed", round: 2 });
  });

  it("updates the mirror from a proxied run state", async () => {
    await h.server.app.inject({ method: "POST", url: `${R}/pause`, headers: AUTH });
    expect(h.runs.get(RUN)?.status).toBe("paused");
  });

  describe("an engine that returns another project's runs", () => {
    const OTHER_PROJECT = "other-app-9f8e7d6c";
    const FOREIGN = "01JB8Z5K3W6Q2V9X4T7R0M1N2Z";
    // Claims to be a run of the default engine's project.
    const forged = { ...runState, id: FOREIGN };
    let rogue: FakeEngine;

    beforeEach(() => {
      rogue = new FakeEngine(
        { container: projectContainerName(OTHER_PROJECT), projectId: OTHER_PROJECT },
        {
          "engine.runs.list": () => ({ runs: [forged] }),
          "engine.runs.get": () => forged,
          "engine.runs.pause": () => forged,
        },
      );
      (h.deps.engines as FakeEngines).engines.unshift(rogue);
    });

    it("leaves them out of runs.list and the mirror", async () => {
      const res = await h.server.app.inject({ method: "GET", url: `${V1}/runs`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      const ids = (res.json().runs as { id: string }[]).map((r) => r.id);
      expect(ids).toEqual([RUN]);
      expect(h.runs.get(FOREIGN)).toBeUndefined();
    });

    it("doesn't treat that engine as the run's holder", async () => {
      const res = await h.server.app.inject({
        method: "POST",
        url: `${V1}/runs/${FOREIGN}/pause`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("run_not_found");
      expect(rogue.calls.map((c) => c.key)).toEqual(["engine.runs.get"]);
      expect(h.runs.get(FOREIGN)).toBeUndefined();
    });
  });
});

describe("jobs", () => {
  it("runs box creation as a job that returns the box", async () => {
    const res = await h.server.app.inject({
      method: "POST",
      url: `${V1}/boxes`,
      headers: AUTH,
      payload: { targetDir: "/work/example-app", conversationName: "new", layout: "worktree" },
    });
    const job = res.json();
    expect(job.kind).toBe("box_create");
    await new Promise((r) => setTimeout(r, 20));
    const done = await h.server.app.inject({
      method: "GET",
      url: `${V1}/jobs/${job.id}`,
      headers: AUTH,
    });
    expect(done.json().status).toBe("finished");
    expect(done.json().result.box.id).toBe("aio-agent-new");
  });

  it("answers an unknown job with not_found", async () => {
    const res = await h.server.app.inject({ method: "GET", url: `${V1}/jobs/nope`, headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe("ssh remotes", () => {
  it("lists remotes with references and tunnel state", async () => {
    const res = await h.server.app.inject({
      method: "GET",
      url: `${V1}/ssh-remotes`,
      headers: AUTH,
    });
    expect(res.json().remotes[0]).toMatchObject({
      remote: { name: sshRemote.name },
      referencedBy: [box.id],
      tunnelUp: true,
    });
  });
});

describe("C2 routes", () => {
  const post = (url: string, payload?: object) =>
    h.server.app.inject({ method: "POST", url, headers: AUTH, ...(payload ? { payload } : {}) });

  it("passes force and dryRun through, with both bodies optional", async () => {
    h.core.views.set(box.id, { ...h.core.views.get(box.id)!, status: "stopped" });
    expect((await post(`${B}/start`, { force: true })).statusCode).toBe(200);
    expect(h.core.calls).toContain(`start:force:${box.id}`);
    expect((await post(`${B}/purge`)).json()).toMatchObject({ dryRun: false });
    expect((await post(`${B}/purge`, { dryRun: true })).json()).toMatchObject({ dryRun: true });
  });

  it("proxies repository routes to the project's engine", async () => {
    const res = await h.server.app.inject({
      method: "GET",
      url: `${P}/repos/refs?repo=/work/example-app`,
      headers: AUTH,
    });
    expect(res.json().localBranches).toEqual(["/work/example-app"]);
    expect(h.engine.calls.at(-1)).toMatchObject({
      key: "engine.repos.refs",
      input: { query: { repo: "/work/example-app" } },
    });
    const missing = await h.server.app.inject({
      method: "GET",
      url: `${V1}/projects/nope/repos`,
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("lists home's subdirectories and refuses relative paths", async () => {
    const res = await h.server.app.inject({
      method: "GET",
      url: `${V1}/fs/dirs`,
      headers: AUTH,
    });
    expect(res.json()).toMatchObject({ path: h.deps.home, entries: [] });
    const relative = await h.server.app.inject({
      method: "GET",
      url: `${V1}/fs/dirs?path=work`,
      headers: AUTH,
    });
    expect(relative.statusCode).toBe(400);
  });

  it("tests an unsaved remote from the body", async () => {
    const res = await post(`${V1}/ssh-remotes/test`, { ...sshRemote, name: "unsaved" });
    expect(res.statusCode).toBe(200);
    expect((await post(`${V1}/ssh-remotes/test`)).statusCode).toBe(400);
  });

  it("runs the import and previews conversion", async () => {
    expect((await post(`${V1}/import`, { dryRun: false })).json()).toMatchObject({
      dryRun: false,
      boxes: 2,
    });
    expect(h.core.calls).toContain("import:false");
    expect((await post(`${B}/convert-to-worktree/plan`)).json()).toMatchObject({
      buildOutputBytes: 0,
    });
  });
});
