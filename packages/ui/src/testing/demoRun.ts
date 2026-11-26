// A scripted event stream that exercises every event type and drives the
// dashboard through two review rounds that end in an oscillation decision.
// Every event is validated with the contract schema as it is built. The
// dashboard tests and the review app's tests replay it, and a fake server can
// emit it to a running app.
import {
  EVENT_TYPES,
  EventSchema,
  defaultConfig,
  type AioEvent,
  type Finding,
  type RoundSummary,
  type RunState,
  type Stage,
  type Vendor,
} from "@aio/contracts";

/** The run the demo stream reviews. */
export const DEMO_RUN_ID = "01JB8Z5K3W6Q2V9X4T7R0M1N2P";
/** The project the demo stream belongs to. */
export const DEMO_PROJECT = "example-app-1a2b3c4d";
/** The project container that runs the demo's engine. */
export const DEMO_CONTAINER = "aio-agent-proj-example-app-1a2b3c4d";
/** The box the demo run reviews. */
export const DEMO_BOX = "aio-agent-emails_not_sending";
/** The stream id of every demo event. */
export const DEMO_STREAM = "server-demo-1";

const RUN_ID = DEMO_RUN_ID;
const PROJECT = DEMO_PROJECT;
const CONTAINER = DEMO_CONTAINER;
const BOX = DEMO_BOX;
const STREAM = DEMO_STREAM;
const ENGINE = `engine:${CONTAINER}`;
const T0 = Date.parse("2026-10-28T09:00:00.000Z");

type Draft = {
  [K in AioEvent["type"]]: Omit<
    Extract<AioEvent, { type: K }>,
    "id" | "time" | "source" | "streamId" | "seq" | "sourceSeq"
  > & { source?: string };
}[AioEvent["type"]];

/** Builds the demo stream: every event type, numbered from 1 in one stream. */
export function buildDemoEvents(): AioEvent[] {
  const events: AioEvent[] = [];
  let clock = 0;

  function at(seconds: number) {
    clock = seconds;
  }

  function emit(draft: Draft, source: string = ENGINE): void {
    const seq = events.length + 1;
    const time = new Date(T0 + clock * 1000).toISOString();
    const event = EventSchema.parse({
      id: `ev-${String(seq).padStart(4, "0")}`,
      time,
      source,
      streamId: STREAM,
      seq,
      sourceSeq: seq,
      ...draft,
    });
    events.push(event);
    clock += 1;
  }

  const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

  const request = {
    projectId: PROJECT,
    boxId: BOX,
    repoPath: "/home/user/src/example-app/.worktrees/Emails_not_sending",
    base: "origin/main",
    tip: "claude/Emails_not_sending",
    mergeBase: true,
    exactBase: false,
    pipeline: "pre-push" as const,
    profile: "offload" as const,
    readOnly: false,
    includeWorktree: false,
    crossVendor: true,
    roundCap: 25,
    overlapThreshold: 0.5,
    continuationCap: 3,
  };

  function run(patch: Partial<RunState>): RunState {
    return {
      id: RUN_ID,
      projectId: PROJECT,
      boxId: BOX,
      container: CONTAINER,
      request,
      status: "running",
      stage: "preflight",
      round: 0,
      baseSha: "4e1c2a9b7d3f",
      tipSha: "a1b2c3d4e5f6",
      profile: "offload",
      roles: {
        reviewer: ["codex", "copilot"],
        disprover: "codex",
        confirmer: "codex",
        fixer: "claude",
      },
      stopReason: null,
      decision: null,
      createdAt: iso(0),
      updatedAt: iso(clock),
      ...patch,
    };
  }

  function stage(next: Stage, prev: Stage | null, round: number) {
    emit({ type: "stage.changed", runId: RUN_ID, round, stage: next, previousStage: prev });
  }

  function handoff(
    round: number,
    from: [
      Stage,
      Vendor | null,
      "reviewer" | "disprover" | "confirmer" | "fixer" | "sweeper" | null,
    ],
    to: [Stage, Vendor | null, "reviewer" | "disprover" | "confirmer" | "fixer" | "sweeper" | null],
    artifact: string,
    count: number,
  ) {
    emit({
      type: "handoff",
      runId: RUN_ID,
      round,
      from: { stage: from[0], vendor: from[1], role: from[2] },
      to: { stage: to[0], vendor: to[1], role: to[2] },
      artifact,
      count,
      file: `round-${round}/${to[0]}-${artifact}.json`,
    });
  }

  const MODELS: Record<Vendor, string> = {
    claude: "claude-opus-5-5",
    codex: "gpt-5.5-codex",
    copilot: "auto",
  };
  let agentN = 0;

  function agent(
    round: number,
    vendor: Vendor,
    role: "reviewer" | "disprover" | "confirmer" | "fixer" | "sweeper",
    groupId: string | null,
    seconds: number,
    tokens: { in: number; out: number },
    cost: number,
  ) {
    agentN += 1;
    const fields = {
      runId: RUN_ID,
      agentId: `a-${agentN}`,
      leaseId: `l-${agentN}`,
      vendor,
      model: MODELS[vendor],
      role,
      groupId,
      round,
    };
    emit({ type: "agent.started", ...fields });
    clock += seconds;
    const premium = vendor === "copilot" ? 1 : 0;
    emit({
      type: "lease.settled",
      leaseId: fields.leaseId,
      runId: RUN_ID,
      vendor,
      role,
      tokens,
      premiumRequests: premium,
      costEstimate: cost,
    });
    emit({
      type: "agent.finished",
      ...fields,
      outcome: "ok",
      elapsedMs: seconds * 1000,
      tokens,
      premiumRequests: premium,
      costEstimate: cost,
    });
  }

  function usage(vendor: Vendor, utilization: number, resetAt: number | null) {
    const ceiling = defaultConfig().ceilings[vendor];
    emit({
      type: "usage.sample",
      vendor,
      account: vendor === "copilot" ? "octo-user" : "user@example.com",
      window: vendor === "copilot" ? "month" : "5h",
      utilization,
      spendUsd: vendor === "copilot" ? utilization * 70 : null,
      ceiling,
      resetAt: resetAt === null ? null : iso(resetAt),
      sampleSource:
        vendor === "claude"
          ? "rate_limit_event"
          : vendor === "codex"
            ? "codex_session"
            : "billing_api",
    });
  }

  function finding(id: string, patch: Partial<Finding>): Finding {
    return {
      id,
      fingerprint: `fp-${id}`,
      severity: "P2",
      title: "Untitled",
      file: "src/mail/send.ts",
      lines: [10, 20],
      failureCase: "A failing case.",
      category: "correctness",
      introduced: true,
      reportedBy: "codex-gpt-5.5",
      alsoReportedBy: [],
      verdict: "pending",
      verification: null,
      evidence: "",
      runId: RUN_ID,
      round: 1,
      groupId: "g1",
      hunkIds: ["h1"],
      origin: "reviewer",
      history: [],
      ...patch,
    };
  }

  function findingChanged(f: Finding, previousVerdict: Finding["verdict"] | null) {
    emit({ type: "finding.changed", runId: RUN_ID, finding: f, previousVerdict });
  }

  const box = {
    id: BOX,
    projectId: PROJECT,
    hostKey: "emails-not-sending",
    targetDir: "/home/user/src/example-app",
    sessionUuid: "0b9f2a7e-4c1d-4e8a-9f3b-2d6c8e1a5b70",
    conversationName: "Emails_not_sending",
    transcriptSyncedName: "Emails_not_sending",
    platform: "claude" as const,
    skipPermissions: true,
    worktree: request.repoPath,
    branch: request.tip,
    container: CONTAINER,
    session: BOX,
    wasRunning: true,
    sshRemoteRefs: [],
    createdAt: iso(0),
    updatedAt: iso(0),
  };

  // --- The story -------------------------------------------------------------

  at(0);
  emit(
    {
      type: "container.changed",
      container: CONTAINER,
      projectId: PROJECT,
      state: "running",
      engine: { hostPort: 20412, version: "1.0.0-dev", healthy: true, versionMatches: true },
    },
    "server",
  );
  emit(
    {
      type: "container.stats",
      container: CONTAINER,
      projectId: PROJECT,
      cpuPercent: 12.5,
      memBytes: 1_800_000_000,
      memLimitBytes: 8_000_000_000,
      diskBytes: 420_000_000,
    },
    "server",
  );
  emit({ type: "box.changed", boxId: BOX, status: "running", box }, "server");
  emit({
    type: "ports.changed",
    container: CONTAINER,
    listeners: [{ port: 5173, proto: "tcp", process: "node", boxId: BOX }],
  });
  emit(
    { type: "settings.changed", settings: defaultConfig(), changedKeys: ["notifications"] },
    "server",
  );
  usage("claude", 0.22, 4 * 3600);
  usage("codex", 0.41, 3 * 3600);
  usage("copilot", 0.3, null);

  emit({
    type: "run.changed",
    run: run({ status: "running", stage: "preflight", round: 0 }),
    roundSummary: null,
  });
  stage("group", "preflight", 0);
  handoff(0, ["preflight", null, null], ["group", null, null], "hunks", 14);

  // Round 1
  stage("find", "group", 1);
  handoff(1, ["group", null, null], ["find", "codex", "reviewer"], "groups", 3);
  handoff(1, ["group", null, null], ["find", "copilot", "reviewer"], "diff", 1);
  agent(1, "codex", "reviewer", "g1", 40, { in: 52_000, out: 4_100 }, 0.42);
  agent(1, "copilot", "reviewer", null, 35, { in: 61_000, out: 3_200 }, 0.04);
  usage("codex", 0.55, 3 * 3600);
  handoff(1, ["find", "codex", "reviewer"], ["merge", null, null], "findings", 5);
  handoff(1, ["find", "copilot", "reviewer"], ["merge", null, null], "findings", 3);
  stage("merge", "find", 1);

  const f1 = finding("F-0001", {
    severity: "P1",
    title: "Retry loop never gives up on SMTP 5xx",
    failureCase: "A permanent 550 reply makes send() retry forever.",
    alsoReportedBy: ["copilot-auto"],
    fingerprint: "fp-retry-loop",
    symbol: "sendWithRetry",
  });
  const f2 = finding("F-0002", {
    title: "Template cache ignores locale",
    lines: [40, 52],
    reportedBy: "copilot-auto",
  });
  const f3 = finding("F-0003", {
    severity: "P3",
    title: "Log line prints the recipient list",
    category: "data exposure",
  });
  const f4 = finding("F-0004", { severity: "nit", title: "Unused import", lines: [1, 1] });
  for (const f of [f1, f2, f3, f4]) findingChanged(f, null);
  handoff(1, ["merge", null, null], ["verify", "claude", "disprover"], "findings", 2);
  handoff(1, ["merge", null, null], ["verify", "codex", "disprover"], "findings", 2);
  stage("verify", "merge", 1);
  agent(1, "claude", "disprover", "g1", 30, { in: 30_000, out: 2_000 }, 0.31);
  usage("claude", 0.3, 4 * 3600);
  agent(1, "codex", "disprover", "g1", 25, { in: 28_000, out: 1_800 }, 0.22);
  const confirmedAt = iso(clock);
  const f1c: Finding = {
    ...f1,
    verdict: "confirmed",
    verification: "script",
    evidence: "repro.sh exits 124 after 30s: send() never returns.",
    history: [
      {
        time: confirmedAt,
        verdict: "confirmed",
        actor: { kind: "agent", vendor: "claude", role: "disprover" },
        round: 1,
      },
    ],
  };
  findingChanged(f1c, "pending");
  const f2d: Finding = {
    ...f2,
    verdict: "disproved",
    verification: "code-reading",
    evidence: "The cache key includes the locale on line 44.",
    history: [
      {
        time: confirmedAt,
        verdict: "disproved",
        actor: { kind: "agent", vendor: "codex", role: "disprover" },
        round: 1,
      },
    ],
  };
  findingChanged(f2d, "pending");
  const f3c: Finding = {
    ...f3,
    verdict: "confirmed",
    verification: "code-reading",
    history: [
      {
        time: confirmedAt,
        verdict: "confirmed",
        actor: { kind: "agent", vendor: "codex", role: "disprover" },
        round: 1,
      },
    ],
  };
  findingChanged(f3c, "pending");
  handoff(1, ["verify", "claude", "disprover"], ["sweep", null, "sweeper"], "patterns", 2);
  stage("sweep", "verify", 1);
  agent(1, "codex", "sweeper", null, 12, { in: 9_000, out: 600 }, 0.05);
  handoff(1, ["sweep", null, "sweeper"], ["fix", "claude", "fixer"], "findings", 2);
  stage("fix", "sweep", 1);
  agent(1, "claude", "fixer", "g1", 90, { in: 80_000, out: 9_500 }, 0.95);
  usage("claude", 0.38, 4 * 3600);
  stage("gate", "fix", 1);
  handoff(1, ["fix", "claude", "fixer"], ["gate", null, null], "commits", 2);
  stage("confirm", "gate", 1);
  handoff(1, ["gate", null, null], ["confirm", "codex", "confirmer"], "fixes", 2);
  agent(1, "codex", "confirmer", null, 20, { in: 15_000, out: 900 }, 0.12);
  const fixedAt = iso(clock);
  const f1f: Finding = {
    ...f1c,
    verdict: "fixed",
    fixCommit: "b7c8d9e0f1a2",
    history: [
      ...f1c.history,
      {
        time: fixedAt,
        verdict: "fixed",
        actor: { kind: "agent", vendor: "codex", role: "confirmer" },
        round: 1,
      },
    ],
  };
  findingChanged(f1f, "confirmed");
  const f3f: Finding = {
    ...f3c,
    verdict: "fixed",
    fixCommit: "c8d9e0f1a2b3",
    history: [
      ...f3c.history,
      {
        time: fixedAt,
        verdict: "fixed",
        actor: { kind: "agent", vendor: "codex", role: "confirmer" },
        round: 1,
      },
    ],
  };
  findingChanged(f3f, "confirmed");

  const round1: RoundSummary = {
    runId: RUN_ID,
    round: 1,
    perVendor: {
      codex: {
        raised: 5,
        confirmed: 2,
        disproved: 1,
        tokensIn: 134_000,
        tokensOut: 9_400,
        premiumRequests: 0,
        costUsd: 0.81,
      },
      copilot: {
        raised: 3,
        confirmed: 1,
        disproved: 0,
        tokensIn: 61_000,
        tokensOut: 3_200,
        premiumRequests: 1,
        costUsd: 0.04,
      },
      claude: {
        raised: 0,
        confirmed: 0,
        disproved: 0,
        tokensIn: 110_000,
        tokensOut: 11_500,
        premiumRequests: 0,
        costUsd: 1.26,
      },
    },
    fixed: 2,
    overlapRate: 0.25,
    costUsd: 2.11,
    startedAt: iso(14),
    finishedAt: iso(clock),
  };
  emit({ type: "run.changed", run: run({ stage: "confirm", round: 1 }), roundSummary: round1 });
  emit(
    {
      type: "notification",
      notificationId: "n-1",
      kind: "round_summary",
      title: "Round 1 finished",
      body: "2 findings confirmed and fixed.",
      runId: RUN_ID,
      boxId: BOX,
      severity: "info",
      read: false,
    },
    "server",
  );

  // Codex passes its ceiling, so the scheduler moves its reviewer role.
  usage("codex", 0.72, 3 * 3600);
  emit(
    {
      type: "ceiling.crossed",
      vendor: "codex",
      account: "user@example.com",
      window: "5h",
      utilization: 0.72,
      ceiling: defaultConfig().ceilings.codex,
      direction: "above",
      resetAt: iso(3 * 3600),
    },
    "server",
  );
  emit({
    type: "role.reassigned",
    runId: RUN_ID,
    role: "reviewer",
    from: ["codex", "copilot"],
    to: ["copilot", "claude"],
    reason: "ceiling",
    effectiveRound: 2,
  });

  // Round 2: the retry-loop bug comes back.
  stage("find", "confirm", 2);
  handoff(2, ["group", null, null], ["find", "copilot", "reviewer"], "diff", 1);
  handoff(2, ["group", null, null], ["find", "claude", "reviewer"], "groups", 3);
  agent(2, "copilot", "reviewer", null, 33, { in: 63_000, out: 2_900 }, 0.04);
  agent(2, "claude", "reviewer", "g1", 45, { in: 70_000, out: 5_000 }, 0.71);
  usage("claude", 0.47, 4 * 3600);
  usage("copilot", 0.31, null);
  handoff(2, ["find", "claude", "reviewer"], ["merge", null, null], "findings", 2);
  handoff(2, ["find", "copilot", "reviewer"], ["merge", null, null], "findings", 1);
  stage("merge", "find", 2);
  const f7 = finding("F-0007", {
    severity: "P1",
    round: 2,
    title: "Retry loop never gives up on SMTP 5xx",
    failureCase: "After the fix, a 554 reply still retries without a limit.",
    reportedBy: "claude-opus",
    fingerprint: "fp-retry-loop",
  });
  findingChanged(f7, null);
  const f8 = finding("F-0008", {
    round: 2,
    severity: "P3",
    title: "Missing test for locale fallback",
    reportedBy: "copilot-auto",
    groupId: null,
    file: "src/mail/templates.ts",
    lines: [5, 9],
  });
  findingChanged(f8, null);
  emit({
    type: "run.changed",
    run: run({
      status: "waiting_decision",
      stage: "merge",
      round: 2,
      roles: {
        reviewer: ["copilot", "claude"],
        disprover: "codex",
        confirmer: "codex",
        fixer: "claude",
      },
      decision: {
        kind: "oscillation",
        findingIds: ["F-0007"],
        options: ["resume", "resume_waive", "cancel"],
        message: "F-0007 has the fingerprint of F-0001, which round 1 fixed in b7c8d9e0f1a2.",
      },
    }),
    roundSummary: null,
  });
  emit(
    {
      type: "notification",
      notificationId: "n-2",
      kind: "decision_needed",
      title: "Run needs a decision",
      body: "A fixed finding came back in round 2.",
      runId: RUN_ID,
      boxId: BOX,
      severity: "warning",
      read: false,
    },
    "server",
  );
  emit(
    {
      type: "terminal.ended",
      terminalId: "t-1",
      boxId: BOX,
      kind: "shell",
      exitCode: 0,
      unexpected: false,
    },
    "server",
  );
  emit(
    {
      type: "container.stats",
      container: CONTAINER,
      projectId: PROJECT,
      cpuPercent: 48.2,
      memBytes: 3_100_000_000,
      memLimitBytes: 8_000_000_000,
      diskBytes: 455_000_000,
    },
    "server",
  );

  // A build in the same project; the review dashboard leaves it out.
  const BUILD_ID = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
  emit({
    type: "build.changed",
    build: {
      id: BUILD_ID,
      slug: "add-export",
      projectId: PROJECT,
      container: CONTAINER,
      status: "running",
      step: "tasks",
      boxId: null,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0 + clock * 1000).toISOString(),
    },
  });
  emit({
    type: "build.task.changed",
    buildId: BUILD_ID,
    taskId: "T1",
    status: "running",
    previousStatus: "pending",
  });
  emit({
    type: "message.sent",
    message: {
      version: 1,
      id: "M1",
      buildId: BUILD_ID,
      from: { kind: "seat", seat: "developer", taskId: "T1" },
      to: { kind: "seat", seat: "project-manager", taskId: null },
      routing: "by_type",
      type: "question",
      taskId: "T1",
      milestone: null,
      paths: [],
      body: "Does the export include archived orders?",
      createdAt: new Date(T0 + clock * 1000).toISOString(),
    },
  });
  emit({
    type: "build.inbox",
    buildId: BUILD_ID,
    slug: "add-export",
    boxId: null,
    item: {
      id: "I1",
      kind: "digest",
      ref: "milestone-M1",
      summary: "Milestone M1 (Export) is done: 1 of 1 milestones.",
      file: "digests/milestone-M1.md",
      path: "/work/example-app/.aio/builds/add-export/digests/milestone-M1.md",
      needsAnswer: false,
      createdAt: new Date(T0 + clock * 1000).toISOString(),
      deliveredAt: null,
      answeredAt: null,
    },
  });
  emit({
    type: "build.seat.usage",
    buildId: BUILD_ID,
    seat: "project-manager",
    turns: 4,
    tokensIn: 12000,
    tokensOut: 800,
    since: new Date(T0).toISOString(),
    through: new Date(T0 + clock * 1000).toISOString(),
  });

  const missing = EVENT_TYPES.filter((t) => !events.some((e) => e.type === t));
  if (missing.length > 0) throw new Error(`The demo misses event types: ${missing.join(", ")}.`);
  return events;
}
