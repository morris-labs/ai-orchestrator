// The C2 gate without Docker: a mock-vendor review run starts from the
// `aio` CLI, streams events, writes run files, and the server mirrors
// it to SQLite. The engine runs as a local process that stands in for a
// project container, registered with the server through
// `AIO_DEV_ENGINES`. The second part sets ceilings through the API and
// checks that the server's scheduler redirects and pauses runs.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CEILINGS,
  projectContainerName,
  type Finding,
  type RunState,
} from "@aio/contracts";
import { BUILD_MAIN, childEnv, cliJson, runCli, tailEvents, waitFor } from "./harness.js";
import { startStack, type Stack } from "./stack.js";

const MOCK_SCRIPT = path.join(import.meta.dirname, "fixtures", "mock-script.json");
const TERMINAL = ["finished", "failed", "cancelled"];

let stack: Stack;
let dir = "";
let repo = "";
let projectId = "";
let engineToken = "";
let cliEnv: NodeJS.ProcessEnv = {};
const engine = () => stack.engine();
const server = () => stack.server;
const api = (method: string, route: string, body?: unknown) => stack.api(method, route, body);
const db = () => stack.db();

/** Every event the engine wrote to a run's `events.jsonl`. */
function runEvents(runId: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(repo, ".aio", "runs", runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function startReview(): Promise<string> {
  const run = await cliJson<RunState>(
    [
      "review",
      "start",
      "--project",
      projectId,
      "--repo",
      repo,
      "--read-only",
      "--depth",
      "thorough",
    ],
    cliEnv,
  );
  expect(run.projectId).toBe(projectId);
  expect(run.container).toBe(projectContainerName(projectId));
  return run.id;
}

async function waitForStatus(runId: string, statuses: string[]): Promise<RunState> {
  return waitFor(`run ${runId} to reach ${statuses.join(" or ")}`, async () => {
    const { run } = await cliJson<{ run: RunState }>(["review", "status", runId], cliEnv);
    if (statuses.includes(run.status)) return run;
    if (TERMINAL.includes(run.status)) {
      throw new Error(`run ${runId} ended ${run.status}: ${run.error ?? run.stopReason}`);
    }
    return undefined;
  });
}

async function setCeilings(ceilings: Record<string, unknown>): Promise<void> {
  await api("PATCH", "/settings", { ceilings });
}

beforeAll(async () => {
  stack = await startStack({
    engineEnv: () => ({ AIO_MOCK_VENDORS: "1", AIO_MOCK_SCRIPT: MOCK_SCRIPT }),
  });
  ({ dir, repo, projectId, engineToken, cliEnv } = stack);
});

afterAll(() => {
  stack?.close();
});

describe("C2: server and engine talk", () => {
  it("registers the development engine without logging its token", () => {
    expect(server().output()).toContain(`Development engine for project ${projectId}`);
    expect(server().output()).not.toContain(engineToken);
    expect(engine().output()).not.toContain(engineToken);
  });

  it("creates the project through the API at the sample repository", async () => {
    const project = (await api("POST", "/projects", { root: repo })) as {
      id: string;
      root: string;
    };
    expect(project).toMatchObject({ id: projectId, root: repo });
    const list = await cliJson<{ projects: Array<{ project: { id: string } }> }>(
      ["project", "list"],
      cliEnv,
    );
    expect(list.projects.map((p) => p.project.id)).toEqual([projectId]);
  });

  let runId = "";

  it("runs a review from the CLI to a clean finish and streams the events", async () => {
    // Round summaries for three rounds, then the run-finished notification.
    const tail = tailEvents(["--types", "notification", "--count", "4"], cliEnv);
    await tail.connected;

    runId = await startReview();
    const run = await waitForStatus(runId, ["finished"]);
    expect(run).toMatchObject({ status: "finished", stage: "done", stopReason: "clean" });

    const status = await runCli(["review", "status", runId], cliEnv);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/Stop reason:\s+clean/);

    const { findings } = await cliJson<{ findings: Finding[] }>(
      ["review", "findings", runId],
      cliEnv,
    );
    expect(
      findings
        .filter((f) => f.verdict === "confirmed")
        .map((f) => f.symbol)
        .sort(),
    ).toEqual(["average_price", "bulk_discount", "page"]);

    expect(await tail.exited).toBe(0);
    const notes = tail.lines().filter((l) => l.type === "notification");
    expect(notes).toHaveLength(4);
    expect(notes.at(-1)).toMatchObject({ kind: "run_finished", runId, source: "server" });
  });

  it("writes the run files under the repository", () => {
    const runDir = path.join(repo, ".aio", "runs", runId);
    for (const file of [
      "state.json",
      "engine.json",
      "preflight.json",
      "findings.json",
      "groups.json",
      "rounds.json",
      "events.jsonl",
      "rounds/1/find.json",
      "rounds/1/merge.json",
      "rounds/1/verify.json",
      "rounds/1/sweep.json",
      "rounds/1/summary.json",
    ]) {
      expect(existsSync(path.join(runDir, file)), file).toBe(true);
    }
    const state = JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8")) as RunState;
    expect(state).toMatchObject({ id: runId, status: "finished", stopReason: "clean" });
  });

  it("mirrors the run, its findings, and the usage samples to SQLite", () => {
    const d = db();
    try {
      const run = d.prepare("SELECT status, container FROM svc_runs WHERE id = ?").get(runId);
      expect(run).toEqual({ status: "finished", container: projectContainerName(projectId) });

      const findings = d
        .prepare("SELECT finding_id, verdict FROM svc_findings WHERE run_id = ? ORDER BY 1")
        .all(runId) as Array<{ finding_id: string; verdict: string }>;
      const files = JSON.parse(
        readFileSync(path.join(repo, ".aio", "runs", runId, "findings.json"), "utf8"),
      ) as { findings: Finding[] } | Finding[];
      const onDisk = (Array.isArray(files) ? files : files.findings)
        .map((f) => ({ finding_id: f.id, verdict: f.verdict }))
        .sort((a, b) => a.finding_id.localeCompare(b.finding_id));
      expect(findings).toEqual(onDisk);
      expect(findings.filter((f) => f.verdict === "confirmed")).toHaveLength(3);

      const vendors = d
        .prepare("SELECT DISTINCT vendor FROM svc_usage_samples ORDER BY vendor")
        .all() as Array<{ vendor: string }>;
      expect(vendors.map((v) => v.vendor)).toEqual(["claude", "codex", "copilot"]);

      const notes = d.prepare("SELECT json FROM svc_notifications").all() as Array<{
        json: string;
      }>;
      expect(
        notes.map((n) => JSON.parse(n.json) as { kind: string; runId: string }),
      ).toContainEqual(expect.objectContaining({ kind: "run_finished", runId }));
    } finally {
      d.close();
    }
  });

  it("gets every lease from the server's scheduler", () => {
    // The server is the engine's only event subscriber, so it answered every
    // lease request; each agent call ran under one and settled it.
    expect(
      engine()
        .output()
        .match(/Event subscriber connected/g),
    ).toHaveLength(1);
    const events = runEvents(runId);
    const started = events.filter((e) => e.type === "agent.started").map((e) => e.leaseId);
    const settled = events.filter((e) => e.type === "lease.settled").map((e) => e.leaseId);
    expect(started.length).toBeGreaterThan(0);
    expect(new Set(settled)).toEqual(new Set(started));
    const d = db();
    try {
      const rows = d
        .prepare("SELECT COUNT(*) AS n FROM svc_lease_settlements WHERE run_id = ?")
        .get(runId) as { n: number };
      expect(rows.n).toBe(settled.length);
    } finally {
      d.close();
    }
  });

  it("redirects the reviewer role when codex is over a zero ceiling", async () => {
    await setCeilings({ codex: { kind: "utilization", window: "5h", max: 0 } });
    const usage = await cliJson<{ vendors: Array<{ vendor: string; overCeiling: boolean }> }>(
      ["review", "usage"],
      cliEnv,
    );
    expect(usage.vendors.find((v) => v.vendor === "codex")?.overCeiling).toBe(true);

    const tail = tailEvents(["--types", "role.reassigned", "--count", "1"], cliEnv);
    await tail.connected;
    const id = await startReview();
    const run = await waitForStatus(id, ["finished"]);
    expect(run.stopReason).toBe("clean");
    expect(run.roles.reviewer).not.toContain("codex");

    // The scheduler announces the move first, before it answers the lease.
    expect(await tail.exited).toBe(0);
    expect(tail.lines().find((l) => l.type === "role.reassigned")).toMatchObject({
      source: "server",
      runId: id,
      role: "reviewer",
      from: ["codex"],
      to: ["copilot"],
      reason: "ceiling",
    });
    // The redirect came in a lease response, so the server owns the event:
    // the engine follows it without a role.reassigned of its own.
    const events = runEvents(id);
    const moves = events.filter((e) => e.type === "role.reassigned" && e.reason === "ceiling");
    expect(moves).toEqual([]);
    const reviewers = events.filter((e) => e.type === "agent.started" && e.role === "reviewer");
    expect(reviewers.length).toBeGreaterThan(0);
    expect(new Set(reviewers.map((e) => e.vendor))).toEqual(new Set(["copilot"]));
    const vendors = new Set(events.filter((e) => e.type === "lease.settled").map((e) => e.vendor));
    expect(vendors.has("codex")).toBe(false);
  });

  it("pauses a run when every vendor is over, and resumes it after the ceilings rise", async () => {
    const zero = { kind: "utilization", window: "5h", max: 0 };
    await setCeilings({ claude: zero, codex: zero, copilot: zero });

    const id = await startReview();
    const waiting = await waitForStatus(id, ["waiting_decision"]);
    expect(waiting.decision).toMatchObject({ kind: "ceiling", options: ["resume", "cancel"] });
    expect(waiting.decision?.message).toMatch(/server paused the run/);

    await setCeilings({ ...DEFAULT_CEILINGS });
    const decided = await runCli(["review", "decide", id, "resume"], cliEnv);
    expect(decided.code, decided.stderr).toBe(0);
    const run = await waitForStatus(id, ["finished"]);
    expect(run.stopReason).toBe("clean");
  });

  it("answers aio-build over the engine's build socket, for its own project only", async () => {
    const buildCli = (project: string, ...args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(
          process.execPath,
          [BUILD_MAIN, ...args],
          {
            env: childEnv({
              AIO_BUILD_SOCKET: path.join(dir, "state", "build.sock"),
              AIO_PROJECT_ID: project,
              AIO_BOX_ID: "box-e2e",
            }),
          },
          (err, stdout, stderr) => {
            const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
            resolve({ code, stdout, stderr });
          },
        );
      });
    const help = await buildCli(projectId, "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("aio-build start SLUG [PLAN_FILE]");
    expect(help.stdout).toContain("aio-build plan SLUG SEAT BRIEF_FILE");
    const own = await buildCli(projectId, "status", "no-such-build");
    expect(own).toMatchObject({ code: 4 });
    expect(own.stderr).toContain(`Project ${projectId} has no build no-such-build`);
    const other = await buildCli("other-project-00000000", "pause", "no-such-build");
    expect(other.code).toBe(4);
  });

  it("stops both processes with exit code 0 on SIGTERM", async () => {
    server().child.kill("SIGTERM");
    expect(await server().exited).toBe(0);
    engine().child.kill("SIGTERM");
    expect(await engine().exited).toBe(0);
    expect(engine().output()).toContain("The engine stopped");
  });
});
