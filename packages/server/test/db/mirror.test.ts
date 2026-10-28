// The run and finding mirror tables, with the contract package's own fixtures.
import { describe, expect, it } from "vitest";
import { FindingSchema, RunRequestSchema, RunStateSchema } from "@agentbox/contracts";
import { openDatabase, repositories } from "../../src/db/index.js";

// Copied from the contract package's test fixtures.
const T0 = "2026-10-28T09:00:00.000Z";
const T1 = "2026-10-28T09:05:00.000Z";
const RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2P";

const finding = {
  id: "F-0001",
  fingerprint: "3f786850e387550fdab836ed7e6dc881de23001b",
  severity: "P1",
  title: "Retry loop never gives up on a closed socket",
  file: "src/mailer.ts",
  lines: [120, 134],
  failureCase: "A closed SMTP socket makes send() retry forever.",
  category: "correctness",
  introduced: true,
  reportedBy: "codex-gpt-5",
  alsoReportedBy: ["copilot-auto"],
  verdict: "fixed",
  verification: "script",
  evidence: "repro.sh exits 124 after 30 s at the tip, 0 after the fix.",
  runId: RUN,
  round: 1,
  groupId: "G-01",
  hunkIds: ["H-0003", "H-0004"],
  origin: "reviewer",
  fixCommit: "a1b2c3d4e5f6",
  history: [
    { time: T0, verdict: "pending", actor: { kind: "agent", vendor: "codex", role: "reviewer" } },
    { time: T1, verdict: "fixed", actor: { kind: "engine" }, round: 1 },
  ],
};

const runState = {
  id: RUN,
  projectId: "app-1a2b3c4d",
  boxId: "claude-agent-fix",
  container: "claude-agent-proj-app-1a2b3c4d",
  request: RunRequestSchema.parse({
    projectId: "app-1a2b3c4d",
    repoPath: "/work/app",
    base: "origin/main",
  }),
  status: "waiting_decision",
  stage: "fix",
  round: 3,
  profile: "offload",
  roles: {
    reviewer: ["codex", "copilot"],
    disprover: "copilot",
    confirmer: "codex",
    fixer: "claude",
  },
  stopReason: null,
  decision: null,
  createdAt: T0,
  updatedAt: T1,
};

describe("runs and findings", () => {
  it("round-trips runs and filters them", () => {
    const r = repositories(openDatabase(":memory:"));
    const run = RunStateSchema.parse(runState);
    r.runs.put(run);
    expect(r.runs.get(RUN)).toEqual(run);
    expect(r.runs.list({ projectId: run.projectId }).map((x) => x.id)).toEqual([RUN]);
    expect(r.runs.list({ status: "finished" })).toEqual([]);
    expect(r.runs.list({ boxId: run.boxId })).toHaveLength(1);
    r.runs.put({ ...run, status: "finished" });
    expect(r.runs.list({ status: "finished" })).toHaveLength(1);
    expect(r.runs.list()).toHaveLength(1);
  });

  it("round-trips findings and filters them", () => {
    const r = repositories(openDatabase(":memory:"));
    const f = FindingSchema.parse(finding);
    r.findings.put(f, new Date());
    expect(r.findings.get(RUN, f.id)).toEqual(f);
    expect(r.findings.list(RUN, { verdict: "fixed", severity: f.severity, round: 1 })).toEqual([f]);
    expect(r.findings.list(RUN, { round: 2 })).toEqual([]);
    expect(r.findings.list("01JB8Z5K3W6Q2V9X4T7R0M1N2Q")).toEqual([]);
  });
});
