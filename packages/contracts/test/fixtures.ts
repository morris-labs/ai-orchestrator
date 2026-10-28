// Sample documents, one or more per schema, used by the round-trip tests.
export const T0 = "2026-10-28T09:00:00.000Z";
export const T1 = "2026-10-28T09:05:00.000Z";
export const UUID = "0b9f2a7e-4c1d-4e8a-9f3b-2d6c8e1a5b70";

export const project = {
  id: "example-app-1a2b3c4d",
  root: "/home/user/src/example-app",
  name: "example-app",
  primaryRepo: "/home/user/src/example-app",
  tcpMaps: [{ host: 18080, container: 8080 }],
  mounts: [{ host: "/srv/data", container: "/srv/data" }],
  secretRefs: [{ name: "API_TOKEN", ref: "op://Dev/Example API/credential" }],
  ceilingsOverride: { claude: { kind: "utilization", window: "5h", max: 0.5 } },
  policyPath: ".claude-box/policy.yaml",
  createdAt: T0,
  updatedAt: T1,
};

export const box = {
  id: "claude-agent-emails_not_sending",
  projectId: project.id,
  targetDir: project.root,
  sessionUuid: UUID,
  conversationName: "Emails_not_sending",
  transcriptSyncedName: "Emails_not_sending",
  platform: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  skipPermissions: true,
  worktree: "/home/user/src/example-app/.worktrees/Emails_not_sending",
  branch: "claude/Emails_not_sending",
  container: "claude-agent-proj-example-app-1a2b3c4d",
  session: "claude-agent-emails_not_sending",
  launchedModel: "claude-opus-5-5",
  launchedEffort: "high",
  wasRunning: true,
  sshRemoteRefs: ["staging"],
  createdAt: T0,
  updatedAt: T1,
  reviewState: { state: "under_review", runId: "R-0001" },
};

/** A box as a fresh import of a 3.3.5 classic record might produce: most fields absent. */
export const minimalBox = {
  id: "claude-agent-example-app",
  projectId: project.id,
  targetDir: project.root,
  createdAt: T0,
  updatedAt: T0,
};

export const sshRemote = {
  name: "staging",
  host: "deploy@staging.example.com:2222",
  identity: "/home/user/.ssh/id_ed25519",
  forwards: [
    {
      direction: "L",
      bindAddress: "localhost",
      bindPort: 15432,
      destHost: "db.internal",
      destPort: 5432,
    },
    {
      direction: "R",
      bindAddress: "0.0.0.0",
      bindPort: 9000,
      destHost: "localhost",
      destPort: 9000,
    },
  ],
};

export const finding = {
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
  runId: "R-0001",
  round: 1,
  groupId: "G-01",
  hunkIds: ["H-0003", "H-0004"],
  origin: "reviewer",
  fixCommit: "a1b2c3d4e5f6",
  history: [
    { time: T0, verdict: "pending", actor: { kind: "agent", vendor: "codex", role: "reviewer" } },
    {
      time: T1,
      verdict: "confirmed",
      actor: { kind: "agent", vendor: "claude", role: "disprover" },
      evidence: "repro.sh hangs",
      round: 1,
    },
    { time: T1, verdict: "fixed", actor: { kind: "engine" }, round: 1 },
  ],
};

export const runRequest = {
  projectId: project.id,
  boxId: box.id,
  repoPath: box.worktree,
  base: "origin/main",
  tip: "claude/Emails_not_sending",
  pipeline: "pre-push",
  profile: "offload",
};

export const fileGroup = {
  id: "G-01",
  files: ["src/mailer.ts", "test/mailer.test.ts"],
  kind: "major",
  changedLines: 212,
  riskPath: false,
  hunks: [{ id: "H-0003", file: "src/mailer.ts", start: 110, end: 140 }],
};

export const roundSummary = {
  runId: "R-0001",
  round: 1,
  perVendor: {
    codex: { raised: 9, confirmed: 5, disproved: 4, tokensIn: 120000, tokensOut: 8000, costUsd: 0 },
    copilot: { raised: 4, confirmed: 2, disproved: 2 },
  },
  fixed: 7,
  overlapRate: 0.25,
  costUsd: 1.4,
  startedAt: T0,
  finishedAt: T1,
};

export const runState = {
  id: "R-0001",
  projectId: project.id,
  boxId: box.id,
  container: box.container,
  request: runRequest,
  status: "waiting_decision",
  stage: "fix",
  round: 3,
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  tipSha: "89abcdef",
  profile: "offload",
  roles: {
    reviewer: ["codex", "copilot"],
    disprover: "copilot",
    confirmer: "codex",
    fixer: "claude",
  },
  stopReason: null,
  decision: {
    kind: "oscillation",
    findingIds: ["F-0001"],
    options: ["resume", "resume_waive", "cancel"],
    message: "F-0001 came back after its fix.",
  },
  createdAt: T0,
  updatedAt: T1,
};

export const policy = {
  version: 1,
  riskPaths: ["src/auth/**", "migrations/**"],
  rules: [{ id: "phi", text: "Never log patient data.", appliesTo: ["src/**"] }],
  tests: [{ command: "pnpm test" }],
  lint: [{ command: "pnpm lint", cwd: "." }],
  environmentLimits: ["Code under win/ runs only on Windows."],
  groupSizeLimit: 300,
};

export const leaseRequest = {
  leaseId: "L-17",
  runId: "R-0001",
  vendor: "claude",
  role: "fixer",
  estimate: { tokens: 40000 },
};

export const leaseResponses = [
  { decision: "granted", leaseId: "L-17", vendor: "codex", redirectedFrom: "claude" },
  {
    decision: "pause",
    leaseId: "L-17",
    resumeAt: T1,
    reason: "Claude is above 60% of its 5-hour window.",
  },
  { decision: "deny", leaseId: "L-17", reason: "The run was cancelled." },
];

export const settings = {
  version: 1,
  serverPort: 20400,
  proxyPort: 20400,
  engineImage: "claude-code",
  ceilings: { copilot: { kind: "spend", period: "month", maxUsd: 50 } },
  notifications: { roundSummary: false },
  promptTemplates: { starter: "" },
  defaultTargetDir: "/home/user/src",
  setupCompleted: true,
  modelCache: {
    imageId: "sha256:abc",
    scannedAt: T0,
    models: ["claude-opus-5-5", "claude-sonnet-5"],
  },
  globalMounts: [{ host: "/home/user/.gitconfig.d", container: "/home/user/.gitconfig.d" }],
  secretRefs: [{ name: "GH_TOKEN", ref: "op://Dev/GitHub/token" }],
};

const ev = (seq: number, source = "engine:claude-agent-proj-example-app-1a2b3c4d") => ({
  id: `E-${seq}`,
  time: T0,
  source,
  seq,
});

const agent = {
  runId: "R-0001",
  agentId: "A-1",
  vendor: "codex",
  model: "gpt-5-codex",
  role: "reviewer",
  groupId: "G-01",
  round: 1,
};

/** One sample of every event type. */
export const events = [
  { ...ev(1), type: "agent.started", ...agent },
  {
    ...ev(2),
    type: "agent.finished",
    ...agent,
    outcome: "ok",
    elapsedMs: 81234,
    tokens: { in: 120000, out: 8000 },
    costEstimate: 0,
  },
  {
    ...ev(3),
    type: "stage.changed",
    runId: "R-0001",
    round: 1,
    stage: "merge",
    previousStage: "find",
  },
  {
    ...ev(4),
    type: "handoff",
    runId: "R-0001",
    round: 1,
    from: { stage: "find", vendor: "codex", role: "reviewer" },
    to: { stage: "merge" },
    artifact: "findings",
    count: 12,
    file: "round-1/find-codex.json",
  },
  { ...ev(5), type: "finding.changed", runId: "R-0001", finding, previousVerdict: "confirmed" },
  {
    ...ev(6),
    type: "usage.sample",
    vendor: "claude",
    account: "user@example.com",
    window: "5h",
    utilization: 0.42,
    resetAt: T1,
    source: "rate_limit_event",
  },
  {
    ...ev(7),
    type: "ceiling.crossed",
    vendor: "claude",
    account: "user@example.com",
    window: "5h",
    utilization: 0.61,
    ceiling: 0.6,
    direction: "above",
    resetAt: T1,
  },
  {
    ...ev(8),
    type: "role.reassigned",
    runId: "R-0001",
    role: "disprover",
    from: "claude",
    to: "codex",
    reason: "ceiling",
    effectiveRound: 2,
  },
  { ...ev(9), type: "run.changed", run: runState, roundSummary },
  { ...ev(10, "server"), type: "box.changed", boxId: box.id, status: "running", box },
  {
    ...ev(11, "server"),
    type: "container.changed",
    container: box.container,
    projectId: project.id,
    state: "running",
    engine: { hostPort: 41234, version: "4.0.0", healthy: true, versionMatches: true },
  },
  {
    ...ev(12),
    type: "ports.changed",
    container: box.container,
    boxId: box.id,
    listeners: [{ port: 5173, proto: "tcp", process: "node", boxId: box.id }],
  },
  {
    ...ev(13, "server"),
    type: "terminal.ended",
    terminalId: "T-1",
    boxId: box.id,
    kind: "session",
    exitCode: 0,
    unexpected: false,
  },
  {
    ...ev(14, "server"),
    type: "notification",
    notificationId: "N-1",
    kind: "decision_needed",
    title: "Run R-0001 needs you",
    body: "F-0001 came back after its fix.",
    runId: "R-0001",
    severity: "warning",
  },
  { ...ev(15), type: "lease.requested", ...leaseRequest },
];
