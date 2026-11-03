// The CLI against another machine: `--machine`, `MACHINE/BOX` arguments,
// and the fleet views of `box list --all-machines` and
// `events --all-machines`. The fake server stands in for this machine's
// server, which relays `/api/v1/machines/MACHINE_ID/proxy/` calls.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { BOX_ID, CONTAINER, PROJECT_ID, box, boxView, job, runState } from "./fixtures.js";

const TOKEN = "cli-test-token";
const NODE = "m0123456789abcdef";
const PROXY = `/api/v1/machines/${NODE}/proxy`;
let server: FakeServer;
let home: string;
let out: string;
let err: string;
let execs: string[][];

function machine(over: Record<string, unknown>) {
  return {
    role: "node",
    status: "online",
    isLocal: false,
    serverVersion: "1.0.0",
    protocol: 1,
    capabilities: [],
    lastSeen: "2026-11-01T10:00:00Z",
    platform: "linux",
    ...over,
  };
}

const MACHINES = [
  machine({ id: "local", name: "desk", role: "both", isLocal: true }),
  machine({ id: NODE, name: "build-server" }),
  machine({ id: "m2", name: "laptop", status: "offline" }),
  machine({ id: "m3", name: "old-pc", status: "revoked" }),
];

beforeEach(async () => {
  server = await startFakeServer(TOKEN);
  home = mkdtempSync(path.join(tmpdir(), "aio-cli-remote-"));
  mkdirSync(path.join(home, ".ai-orchestrator"));
  writeFileSync(path.join(home, ".ai-orchestrator", "server.crt"), server.cert);
  server.on("GET /api/v1/machines", { body: { machines: MACHINES } });
  out = "";
  err = "";
  execs = [];
});
afterEach(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

function cli(args: string[], cwd?: string, onErr?: () => void) {
  return runCli(args, {
    cwd,
    env: { AIO_SERVER: server.url, AIO_TOKEN: TOKEN },
    home,
    out: (t) => (out += t),
    err: (t) => {
      err += t;
      onErr?.();
    },
    pollMs: 5,
    exec: async (argv) => {
      execs.push(argv);
      return 0;
    },
  });
}

/** Every request but the machine list, as `METHOD /path`. */
const calls = () =>
  server.requests.filter((r) => r.path !== "/api/v1/machines").map((r) => `${r.method} ${r.path}`);

const remoteBox = () => ({
  ...boxView("stopped"),
  box: { ...box, targetDir: "/srv/site", conversationName: "Node site" },
});

describe("--machine", () => {
  it("takes the live machine when a revoked machine has the same name", async () => {
    server.on("GET /api/v1/machines", {
      body: {
        machines: [
          MACHINES[0],
          machine({ id: "m-old", name: "build-server", status: "revoked" }),
          machine({ id: NODE, name: "build-server" }),
        ],
      },
    });
    server.on(`POST ${PROXY}/usage/clear`, { body: { vendors: [], cleared: 1 } });
    expect(await cli(["--machine", "build-server", "review", "clear-usage", "codex"])).toBe(0);
    expect(calls()).toEqual([`POST ${PROXY}/usage/clear`]);
  });

  it("sends a review's roles, tier, and cross-vendor choice to the machine", async () => {
    server.on(`POST ${PROXY}/runs`, { status: 201, body: runState });
    const flags = ["--role", "reviewer=codex", "--tier", "large", "--no-cross-vendor"];
    const args = ["--project", PROJECT_ID, "--repo", "/srv/site", ...flags];
    expect(await cli(["--machine", "build-server", "review", "start", ...args])).toBe(0);
    expect(calls()).toEqual([`POST ${PROXY}/runs`]);
    expect(server.requests.at(-1)?.body).toMatchObject({
      repoPath: "/srv/site",
      roles: { reviewer: ["codex"] },
      modelTier: "large",
      crossVendor: false,
    });
  });

  it("takes the machine of a review's MACHINE/BOX argument", async () => {
    server.on(`GET ${PROXY}/boxes/${BOX_ID}`, { body: remoteBox() });
    server.on(`POST ${PROXY}/runs`, { status: 201, body: runState });
    const ref = `build-server/${BOX_ID}`;
    expect(await cli(["review", "start", "--box", ref, "--tier", "small"])).toBe(0);
    expect(server.requests.at(-1)?.path).toBe(`${PROXY}/runs`);
    expect(server.requests.at(-1)?.body).toMatchObject({ boxId: BOX_ID, modelTier: "small" });
  });

  it("clears another machine's usage block", async () => {
    server.on(`POST ${PROXY}/usage/clear`, { body: { vendors: [], cleared: 1 } });
    expect(await cli(["--machine", "build-server", "review", "clear-usage", "codex"])).toBe(0);
    expect(calls()).toEqual([`POST ${PROXY}/usage/clear`]);
    expect(server.requests.at(-1)?.body).toEqual({ vendor: "codex" });
  });

  it("lists another machine's boxes through the proxy route, by name or ID", async () => {
    server.on(`GET ${PROXY}/boxes`, { body: { boxes: [remoteBox()] } });
    expect(await cli(["--machine", "build-server", "box", "list"])).toBe(0);
    expect(out).toContain("Node site");
    expect(calls()).toEqual([`GET ${PROXY}/boxes`]);

    out = "";
    expect(await cli(["--machine", NODE, "box", "list", "--project", PROJECT_ID])).toBe(0);
    expect(server.requests.at(-1)?.query).toEqual({ projectId: PROJECT_ID });
  });

  it("sends local and this machine's own name to the plain routes", async () => {
    server.on("GET /api/v1/boxes", { body: { boxes: [boxView()] } });
    expect(await cli(["--machine", "local", "box", "list"])).toBe(0);
    expect(await cli(["--machine", "desk", "box", "list"])).toBe(0);
    expect(calls()).toEqual(["GET /api/v1/boxes", "GET /api/v1/boxes"]);
  });

  it("refuses a machine the server doesn't know", async () => {
    expect(await cli(["--machine", "nowhere", "box", "list"])).toBe(2);
    expect(err).toContain("No machine has the ID or name nowhere");
    expect(calls()).toEqual([]);
  });

  it("refuses another machine on a server without machine routes", async () => {
    server.on("GET /api/v1/machines", {
      status: 404,
      body: { error: { code: "not_found", message: "No route." } },
    });
    expect(await cli(["--machine", "build-server", "box", "list"])).toBe(2);
    expect(err).toContain("has no machine routes");
  });

  it("reports the hub's error for an offline machine", async () => {
    server.on(`GET /api/v1/machines/m2/proxy/boxes`, {
      status: 503,
      body: { error: { code: "machine_offline", message: "Machine m2 is offline." } },
    });
    expect(await cli(["--machine", "laptop", "box", "list"])).toBe(1);
    expect(err).toContain("Error (machine_offline): Machine m2 is offline.");
  });

  it("starts, stops, restarts, edits, and removes a box on another machine", async () => {
    const view = { body: remoteBox() };
    server.on(`POST ${PROXY}/boxes/${BOX_ID}/start`, view);
    server.on(`POST ${PROXY}/boxes/${BOX_ID}/stop`, view);
    server.on(`POST ${PROXY}/boxes/${BOX_ID}/restart`, view);
    server.on(`PATCH ${PROXY}/boxes/${BOX_ID}`, {
      body: { box: remoteBox(), restartRequired: true },
    });
    server.on(`DELETE ${PROXY}/boxes/${BOX_ID}`, {
      body: { removed: true, worktree: "kept", reason: null },
    });
    const m = ["--machine", "build-server"];
    expect(await cli([...m, "box", "start", BOX_ID])).toBe(0);
    expect(await cli([...m, "box", "stop", BOX_ID])).toBe(0);
    expect(await cli([...m, "box", "restart", BOX_ID])).toBe(0);
    expect(await cli([...m, "box", "account", BOX_ID, "claude/work"])).toBe(0);
    expect(await cli([...m, "box", "remove", BOX_ID])).toBe(0);
    expect(calls()).toEqual([
      `POST ${PROXY}/boxes/${BOX_ID}/start`,
      `POST ${PROXY}/boxes/${BOX_ID}/stop`,
      `POST ${PROXY}/boxes/${BOX_ID}/restart`,
      `PATCH ${PROXY}/boxes/${BOX_ID}`,
      `DELETE ${PROXY}/boxes/${BOX_ID}`,
    ]);
    expect(err).toBe("");
  });

  it("creates a box on another machine with its own absolute path", async () => {
    server.on(`POST ${PROXY}/boxes`, { status: 202, body: job("running") });
    server.on(`GET ${PROXY}/jobs/job-1`, { body: job("finished") });
    expect(
      await cli(["--machine", "build-server", "box", "new", "/srv/site//app/"], "/home/user"),
    ).toBe(0);
    expect(server.requests.find((r) => r.path === `${PROXY}/boxes`)?.body).toMatchObject({
      targetDir: "/srv/site/app/",
    });
    expect(calls()).toEqual([`POST ${PROXY}/boxes`, `GET ${PROXY}/jobs/job-1`]);
    expect(out).toContain(`Created ${BOX_ID}.`);
  });

  it("refuses a relative path for another machine", async () => {
    expect(await cli(["--machine", "build-server", "box", "new", "site"], "/home/user")).toBe(2);
    expect(err).toContain("site is a relative path");
    expect(err).toContain("absolute path on build-server");
    expect(
      await cli(
        ["--machine", "build-server", "project", "set", PROJECT_ID, "--mount", "data:/data"],
        "/home/user",
      ),
    ).toBe(2);
    expect(calls()).toEqual([]);
  });

  it("uses a Windows machine's drive paths for mounts", async () => {
    server.on("GET /api/v1/machines", {
      body: { machines: [MACHINES[0], machine({ id: NODE, name: "win-pc", platform: "win32" })] },
    });
    server.on(`PATCH ${PROXY}/projects/${PROJECT_ID}`, {
      body: {
        project: {
          id: PROJECT_ID,
          name: "Example",
          root: "C:\\work",
          primaryRepo: null,
          tcpMaps: [],
          mounts: [],
          secretRefs: [],
          policyPath: ".aio/policy.yaml",
          ceilingsOverride: null,
        },
        staleBoxes: [],
      },
    });
    await cli(["--machine", "win-pc", "project", "set", PROJECT_ID, "--mount", "D:\\data"]);
    expect(server.requests.at(-1)?.body).toEqual({
      mounts: [{ host: "D:\\data", container: "/mnt/host/d/data" }],
    });
  });

  it("refuses box open for another machine's box", async () => {
    expect(await cli(["--machine", "build-server", "box", "open", BOX_ID])).toBe(2);
    expect(err).toContain("run aio box attach MACHINE/BOX");
    expect(execs).toEqual([]);
    expect(calls()).toEqual([]);
  });

  it("refuses --machine for commands about this machine", async () => {
    for (const args of [["machines", "list"], ["node", "status"], ["doctor"]]) {
      err = "";
      expect(await cli(["--machine", "build-server", ...args])).toBe(2);
      expect(err).toContain("works on this machine only");
    }
    expect(server.requests).toEqual([]);
  });
});

describe("MACHINE/BOX arguments", () => {
  it("sends a qualified box to its machine", async () => {
    server.on(`POST ${PROXY}/boxes/${BOX_ID}/stop`, { body: remoteBox() });
    expect(await cli(["box", "stop", `build-server/${BOX_ID}`])).toBe(0);
    expect(calls()).toEqual([`POST ${PROXY}/boxes/${BOX_ID}/stop`]);
  });

  it("refuses a box whose machine differs from --machine", async () => {
    expect(await cli(["--machine", "laptop", "box", "stop", `build-server/${BOX_ID}`])).toBe(2);
    expect(err).toContain("names build-server, but --machine names laptop");
    expect(await cli(["box", "stop", "build-server/"])).toBe(2);
    expect(err).toContain("use BOX or MACHINE/BOX");
  });
});

describe("box list --all-machines", () => {
  it("lists every online machine's boxes with qualified IDs and notes the rest", async () => {
    server.on("GET /api/v1/boxes", { body: { boxes: [boxView()] } });
    server.on(`GET ${PROXY}/boxes`, { body: { boxes: [remoteBox()] } });
    expect(await cli(["box", "list", "--all-machines"])).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines[0]).toMatch(/^MACHINE\s+BOX\s+STATUS/);
    expect(lines[1]).toMatch(new RegExp(`^desk\\s+${BOX_ID}\\s+running`));
    expect(lines[2]).toMatch(new RegExp(`^build-server\\s+build-server/${BOX_ID}\\s+stopped`));
    expect(lines).toHaveLength(3);
    expect(err).toContain("Warning: no boxes from laptop: it is offline.");
    expect(err).not.toContain("old-pc");
    expect(calls().sort()).toEqual([`GET ${PROXY}/boxes`, "GET /api/v1/boxes"].sort());
  });

  it("prints each machine's part as JSON and fails when a machine's call fails", async () => {
    server.on("GET /api/v1/boxes", { body: { boxes: [boxView()] } });
    server.on(`GET ${PROXY}/boxes`, {
      status: 504,
      body: { error: { code: "machine_timeout", message: "It didn't answer in time." } },
    });
    expect(await cli(["--json", "box", "list", "--all-machines"])).toBe(1);
    const parsed = JSON.parse(out) as { machines: { name: string; error: unknown }[] };
    expect(parsed.machines.map((m) => m.name)).toEqual(["desk", "build-server", "laptop"]);
    expect(parsed.machines[1]?.error).toEqual({
      code: "machine_timeout",
      message: "It didn't answer in time.",
    });
    expect(err).toContain("no boxes from build-server: It didn't answer in time.");
  });

  it("lists only this machine on a server without machine routes", async () => {
    server.on("GET /api/v1/machines", {
      status: 404,
      body: { error: { code: "not_found", message: "No route." } },
    });
    server.on("GET /api/v1/boxes", { body: { boxes: [boxView()] } });
    expect(await cli(["box", "list", "--all-machines"])).toBe(0);
    expect(out).toMatch(new RegExp(`^local\\s+${BOX_ID}`, "m"));
  });
});

describe("events", () => {
  const event = (seq: number, extra: Record<string, unknown> = {}) => ({
    id: `e${seq}`,
    time: "2026-11-01T10:00:00.000Z",
    source: `engine:${CONTAINER}`,
    streamId: "srv-1",
    seq,
    sourceSeq: seq,
    type: "ports.changed",
    container: CONTAINER,
    listeners: [],
    ...extra,
  });

  it("tails another machine's stream through the proxy route, with its machine tag", async () => {
    server.eventsByPath[`${PROXY}/events`] = [event(1, { machine: NODE })];
    expect(await cli(["--machine", "build-server", "events", "--count", "1"])).toBe(0);
    expect(server.eventPaths).toEqual([`${PROXY}/events`]);
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; machine?: string });
    expect(lines.map((l) => l.type)).toEqual(["hello", "ports.changed"]);
    expect(lines[1]?.machine).toBe(NODE);
  });

  it("merges every online machine's stream with --all-machines", async () => {
    server.eventsByPath["/api/v1/events"] = [event(1)];
    server.eventsByPath[`${PROXY}/events`] = [event(1, { machine: NODE })];
    expect(await cli(["events", "--all-machines", "--count", "2"])).toBe(0);
    expect([...server.eventPaths].sort()).toEqual([`${PROXY}/events`, "/api/v1/events"].sort());
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; machine?: string });
    const events = lines.filter((l) => l.type !== "hello");
    expect(events.map((l) => l.machine ?? "local").sort()).toEqual(["local", NODE].sort());
    expect(err).not.toContain("no more events");
  });

  it.each([
    [1000, "Its event stream closed."],
    [1001, "Its event stream closed."],
    [1014, "The server closed the event stream: The link to the machine closed. (code 1014)."],
  ])(
    "warns, keeps tailing, and exits 1 when another machine's stream closes with %i",
    async (code, why) => {
      server.eventsByPath["/api/v1/events"] = [];
      server.closeEventsByPath[`${PROXY}/events`] = {
        code,
        reason: code === 1014 ? "The link to the machine closed." : "",
      };
      // This server's event arrives only after the warning, so `--count` ends
      // the command on a stream that outlived the lost machine.
      const args = ["events", "--all-machines", "--count", "1"];
      const exit = await cli(args, undefined, () => {
        server.pushEvent("/api/v1/events", event(1));
      });
      expect(exit).toBe(1);
      expect(err).toContain(`Warning: no more events from build-server: ${why}`);
      expect(out).toContain('"ports.changed"');
    },
  );

  it("exits 0 and warns about nothing when this server's stream ends first", async () => {
    server.closeEventsByPath["/api/v1/events"] = { code: 1000, reason: "" };
    server.eventsByPath[`${PROXY}/events`] = [event(1, { machine: NODE })];
    expect(await cli(["events", "--all-machines", "--count", "1"])).toBe(0);
    expect(err).not.toContain("no more events");
  });
});
