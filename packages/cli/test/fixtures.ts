// Sample server responses for CLI tests.
export const T0 = "2026-10-28T09:00:00.000Z";
export const RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2P";
export const PROJECT_ID = "example-1a2b3c4d";
export const CONTAINER = "aio-agent-proj-example-1a2b3c4d";
export const BOX_ID = "aio-agent-feature";

export const project = {
  id: PROJECT_ID,
  root: "/home/user/src/example",
  name: "example",
  tcpMaps: [],
  mounts: [],
  secretRefs: [{ name: "API_TOKEN", ref: "op://Dev/Example/credential" }],
  policyPath: ".aio/policy.yaml",
  createdAt: T0,
  updatedAt: T0,
};

export const engine = {
  hostPort: 32768,
  version: "1.0.0-dev",
  healthy: true,
  versionMatches: true,
};

export const projectSummary = {
  project,
  running: 1,
  total: 2,
  container: { name: CONTAINER, state: "running", engine },
};

export const box = {
  id: BOX_ID,
  projectId: PROJECT_ID,
  hostKey: "feature",
  targetDir: project.root,
  sessionUuid: "0b9f2a7e-4c1d-4e8a-9f3b-2d6c8e1a5b70",
  conversationName: "feature",
  transcriptSyncedName: "feature",
  platform: "claude",
  skipPermissions: true,
  worktree: "/home/user/src/example/.worktrees/feature",
  branch: "claude/feature",
  container: CONTAINER,
  session: BOX_ID,
  wasRunning: true,
  sshRemoteRefs: [],
  createdAt: T0,
  updatedAt: T0,
};

export function boxView(status = "running") {
  return {
    box,
    status,
    container: CONTAINER,
    tmuxSession: BOX_ID,
    targetDirExists: true,
    reviewState: { state: "idle" },
    stats: null,
    listeners: [],
    proxyUrls: [],
    sideSessions: [],
  };
}

export function job(status: "running" | "finished" | "failed") {
  return {
    id: "job-1",
    kind: "box_create",
    boxId: BOX_ID,
    command: "aio box new",
    status,
    exitCode: status === "running" ? null : status === "failed" ? 1 : 0,
    error:
      status === "failed" ? { code: "image_missing", message: "Build the image first." } : null,
    result: null,
    startedAt: T0,
    finishedAt: status === "running" ? null : T0,
  };
}

export const runState = {
  id: RUN,
  projectId: PROJECT_ID,
  boxId: BOX_ID,
  container: CONTAINER,
  request: {
    projectId: PROJECT_ID,
    boxId: BOX_ID,
    repoPath: box.worktree,
    base: "origin/main",
    tip: "claude/feature",
    mergeBase: true,
    exactBase: false,
    pipeline: "pre-push",
    profile: "offload",
    readOnly: false,
    includeWorktree: false,
    crossVendor: true,
    roundCap: 25,
    overlapThreshold: 0.5,
    continuationCap: 3,
  },
  status: "running",
  stage: "find",
  round: 1,
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
  updatedAt: T0,
};

export const finding = {
  id: "F-0001",
  fingerprint: "3f786850e387550fdab836ed7e6dc881de23001b",
  severity: "P1",
  title: "Retry loop never gives up",
  file: "src/mailer.ts",
  lines: [120, 134],
  failureCase: "A closed socket retries forever.",
  category: "correctness",
  introduced: true,
  reportedBy: "codex-gpt-5",
  alsoReportedBy: [],
  verdict: "confirmed",
  verification: "script",
  evidence: "repro.sh hangs",
  runId: RUN,
  round: 1,
  groupId: "G-01",
  hunkIds: [],
  origin: "reviewer",
  history: [],
};

export const roundSummary = {
  runId: RUN,
  round: 1,
  perVendor: {
    codex: {
      raised: 4,
      confirmed: 2,
      disproved: 2,
      tokensIn: 10,
      tokensOut: 5,
      premiumRequests: 0,
      costUsd: 0,
    },
  },
  fixed: 2,
  overlapRate: 0.25,
  costUsd: 1.4,
  startedAt: T0,
  finishedAt: T0,
};

export const ceiling = { kind: "utilization", window: "5h", max: 0.6 };

export const vendorUsage = {
  vendor: "claude",
  account: "user@example.com",
  ceiling,
  latest: [
    {
      vendor: "claude",
      account: "user@example.com",
      window: "5h",
      utilization: 0.42,
      spendUsd: null,
      ceiling,
      resetAt: T0,
      sampleSource: "rate_limit_event",
      time: T0,
    },
  ],
  overCeiling: false,
  forecastAt: null,
  resetAt: T0,
  window: "5h",
};

export const setupStatus = {
  completed: true,
  defaultTargetDir: null,
  checks: [
    { id: "docker", status: "ok", message: "Docker 27 answers.", fixable: false },
    { id: "image", status: "ok", message: "aio-agent exists.", fixable: false },
    { id: "engine", status: "warn", message: "No engine running.", fixable: false },
    { id: "op", status: "fail", message: "op isn't installed.", fixable: true },
    { id: "sudo", status: "ok", message: "sudo is off in containers.", fixable: false },
  ],
};

export const imageStatus = {
  name: "aio-agent",
  exists: true,
  imageId: "sha256:abc",
  createdAt: T0,
  engineVersion: "1.0.0-dev",
  expectedEngineVersion: "1.0.0-dev",
  engineMatches: true,
  cliVersions: { claude: "2.1.300", codex: null, copilot: null },
};
