// The `aio-box-review` command against a stand-in for the broker's review
// routes, which answers like the server: a run of the box's own branch, and
// refusals for another branch.
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunRequestSchema, type Finding, type RunState } from "@aio/contracts";
import { boxReviewMain, parseBoxReviewArgs } from "../../src/box-review/cli.js";
import { tempDir } from "../tmp.js";

const PROJECT = "example-app-1a2b3c4d";
const BOX = "aio-agent-emails";
const RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2P";
const T = "2026-10-28T09:00:00.000Z";

function runState(patch: Partial<RunState> = {}): RunState {
  return {
    id: RUN,
    projectId: PROJECT,
    boxId: BOX,
    container: "aio-agent-proj-example-app-1a2b3c4d",
    request: RunRequestSchema.parse({
      projectId: PROJECT,
      boxId: BOX,
      repoPath: "/work/example-app/.worktrees/emails",
      tip: "claude/emails",
    }),
    status: "pending",
    stage: "preflight",
    round: 0,
    profile: "offload",
    roles: { reviewer: ["codex"], disprover: "copilot", confirmer: "codex", fixer: "claude" },
    stopReason: null,
    decision: null,
    createdAt: T,
    updatedAt: T,
    ...patch,
  };
}

function finding(id: string, verdict: Finding["verdict"], title: string): Finding {
  return {
    id,
    fingerprint: "3f786850e387550fdab836ed7e6dc881de23001b",
    severity: "P1",
    title,
    file: "src/mailer.ts",
    lines: [120, 134],
    failureCase: "A closed socket retries forever.",
    category: "correctness",
    introduced: true,
    reportedBy: "codex-gpt-5",
    alsoReportedBy: [],
    verdict,
    verification: "script",
    evidence: "repro.sh",
    runId: RUN,
    round: 1,
    groupId: "G-01",
    hunkIds: [],
    origin: "reviewer",
    history: [],
  } as Finding;
}

interface FakeReviewBroker {
  socketPath: string;
  starts: unknown[];
  gets: string[];
  close(): Promise<void>;
}

/** Answers the start request, then each run read with the next of `states`. */
async function startFakeReviewBroker(
  states: RunState[],
  findings: Finding[] = [],
): Promise<FakeReviewBroker> {
  const socketPath = path.join(tempDir("aio-fake-review-"), "broker.sock");
  let read = 0;
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/review/start") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { branch?: string };
        state.starts.push(body);
        if (body.branch !== undefined && body.branch !== "claude/emails") {
          return send(res, 400, {
            error: {
              code: "validation",
              message: `Box ${BOX} can review only its own branch, claude/emails.`,
            },
          });
        }
        return send(res, 201, runState());
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/review/runs/")) {
        state.gets.push(req.url);
        const run = states[Math.min(read, states.length - 1)]!;
        read += 1;
        return send(res, 200, { run, findings });
      }
      return send(res, 404, { error: { code: "not_found", message: "no route" } });
    });
  });
  const state: FakeReviewBroker = {
    socketPath,
    starts: [],
    gets: [],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return state;
}

const brokers: FakeReviewBroker[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.close();
});

async function run(
  argv: string[],
  broker: FakeReviewBroker,
  env: Record<string, string | undefined> = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await boxReviewMain(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env: { AIO_BROKER_SOCKET: broker.socketPath, AIO_BOX_ID: BOX, ...env },
    sleep: async () => undefined,
  });
  return { code, stdout, stderr };
}

describe("parseBoxReviewArgs", () => {
  it("parses each request", () => {
    expect(parseBoxReviewArgs(["start"])).toEqual({
      kind: "start",
      request: {},
      wait: true,
      json: false,
    });
    expect(
      parseBoxReviewArgs([
        "start",
        "--base",
        "origin/dev",
        "--branch",
        "claude/emails",
        "--read-only",
        "--depth",
        "thorough",
        "--profile",
        "balanced",
        "--no-wait",
        "--json",
      ]),
    ).toEqual({
      kind: "start",
      request: {
        base: "origin/dev",
        branch: "claude/emails",
        readOnly: true,
        depth: "thorough",
        profile: "balanced",
      },
      wait: false,
      json: true,
    });
    expect(parseBoxReviewArgs(["status", RUN, "--wait"])).toEqual({
      kind: "status",
      runId: RUN,
      wait: true,
      json: false,
    });
    expect(parseBoxReviewArgs(["--help"])).toEqual({ kind: "help" });
  });

  it.each([
    [[]],
    [["start", "--depth", "deep"]],
    [["start", "--base"]],
    [["start", "extra"]],
    [["status"]],
    [["status", RUN, "--no-wait"]],
    [["nothing"]],
  ])("refuses %j", (argv) => {
    expect(() => parseBoxReviewArgs(argv)).toThrow();
  });
});

describe("boxReviewMain", () => {
  it("starts a run of the box's branch, waits for it, and prints the confirmed findings", async () => {
    const b = await startFakeReviewBroker(
      [
        runState({ status: "running", stage: "find", round: 1 }),
        runState({ status: "paused", stage: "find", round: 1 }),
        runState({ status: "finished", stage: "done", round: 2, stopReason: "clean" }),
      ],
      [
        finding("F-0001", "fixed", "Retry loop never gives up"),
        finding("F-0002", "disproved", "Not a real problem"),
        finding("F-0003", "confirmed", "Header is never escaped"),
      ],
    );
    brokers.push(b);
    const r = await run(["start", "--base", "origin/dev"], b);
    expect(r.code).toBe(0);
    expect(b.starts).toEqual([{ boxId: BOX, base: "origin/dev" }]);
    expect(b.gets).toHaveLength(3);
    expect(b.gets[0]).toBe(`/v1/review/runs/${RUN}?boxId=${BOX}`);
    expect(r.stderr).toContain(`Started review run ${RUN}`);
    expect(r.stderr).toContain("running");
    expect(r.stdout).toContain(`Run ${RUN} finished: clean.`);
    expect(r.stdout).toContain("F-0001 P1 fixed src/mailer.ts:120-134 Retry loop never gives up");
    expect(r.stdout).toContain("F-0003 P1 confirmed");
    expect(r.stdout).not.toContain("F-0002");
  });

  it("prints the run and findings as JSON", async () => {
    const b = await startFakeReviewBroker(
      [runState({ status: "finished", stage: "done", stopReason: "clean" })],
      [finding("F-0001", "confirmed", "Retry loop never gives up")],
    );
    brokers.push(b);
    const r = await run(["start", "--json"], b);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { run: RunState; findings: Finding[] };
    expect(out.run.status).toBe("finished");
    expect(out.findings.map((f) => f.id)).toEqual(["F-0001"]);
  });

  it("returns at once with --no-wait", async () => {
    const b = await startFakeReviewBroker([runState()]);
    brokers.push(b);
    const r = await run(["start", "--no-wait"], b);
    expect(r.code).toBe(0);
    expect(b.gets).toHaveLength(0);
    expect(r.stdout).toContain(RUN);
  });

  it("exits 4 when the server refuses another branch", async () => {
    const b = await startFakeReviewBroker([runState()]);
    brokers.push(b);
    const r = await run(["start", "--branch", "main"], b);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("can review only its own branch");
  });

  it("exits 1 for a failed run and 6 for a run that waits for a decision", async () => {
    const failed = await startFakeReviewBroker([
      runState({ status: "failed", stage: "gate", stopReason: "error", error: "Gate broke." }),
    ]);
    brokers.push(failed);
    const f = await run(["status", RUN, "--wait"], failed);
    expect(f.code).toBe(1);
    expect(f.stdout).toContain("failed");
    expect(f.stdout).toContain("Gate broke.");
    const waiting = await startFakeReviewBroker([
      runState({ status: "waiting_decision", stage: "verify" }),
    ]);
    brokers.push(waiting);
    const w = await run(["status", RUN, "--wait"], waiting);
    expect(w.code).toBe(6);
    expect(w.stdout).toContain("waits for a decision");
  });

  it("needs the box ID, and reports an unreachable broker", async () => {
    const b = await startFakeReviewBroker([runState()]);
    brokers.push(b);
    const noBox = await run(["start"], b, { AIO_BOX_ID: undefined });
    expect(noBox.code).toBe(2);
    expect(noBox.stderr).toContain("AIO_BOX_ID");
    const gone = await run(["start"], b, {
      AIO_BROKER_SOCKET: path.join(tempDir("aio-gone-"), "broker.sock"),
    });
    expect(gone.code).toBe(3);
  });
});
