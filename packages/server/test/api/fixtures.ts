// Sample contract documents for the API tests.
import {
  DEFAULT_POLICY,
  RunRequestSchema,
  projectContainerName,
  type Box,
  type BoxView,
  type Project,
  type ProjectSummary,
  type RunState,
  type SshRemote,
} from "@aio/contracts";

export const T0 = "2026-10-28T09:00:00.000Z";
export const T1 = "2026-10-28T09:05:00.000Z";
export const UUID = "0b9f2a7e-4c1d-4e8a-9f3b-2d6c8e1a5b70";
export const RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2P";

export const PROJECT_ID = "example-app-1a2b3c4d";
export const CONTAINER = projectContainerName(PROJECT_ID);

export const project: Project = {
  id: PROJECT_ID,
  root: "/work/example-app",
  name: "example-app",
  tcpMaps: [],
  mounts: [],
  secretRefs: [{ name: "API_TOKEN", ref: "op://Dev/Example API/credential" }],
  policyPath: ".aio/policy.yaml",
  createdAt: T0,
  updatedAt: T1,
};

export const projectSummary: ProjectSummary = {
  project,
  running: 1,
  total: 1,
  container: { name: CONTAINER, state: "running", engine: null },
};

export const box: Box = {
  id: "aio-agent-emails",
  projectId: PROJECT_ID,
  hostKey: "emails",
  targetDir: project.root,
  sessionUuid: UUID,
  conversationName: "emails",
  transcriptSyncedName: "emails",
  platform: "claude",
  skipPermissions: true,
  worktree: "/work/example-app/.worktrees/emails",
  branch: "claude/emails",
  container: CONTAINER,
  session: "aio-agent-emails",
  wasRunning: true,
  sshRemoteRefs: ["staging"],
  createdAt: T0,
  updatedAt: T1,
};

export function viewOf(b: Box, status: BoxView["status"] = "running"): BoxView {
  return {
    box: b,
    status,
    container: b.container,
    tmuxSession: b.session,
    reviewState: { state: "idle" },
    stats: null,
    listeners: [],
    proxyUrls: [],
    sideSessions: [],
    targetDirExists: true,
  };
}

export const sshRemote: SshRemote = {
  name: "staging",
  host: "deploy@staging.example.com:2222",
  forwards: [
    {
      direction: "L",
      bindAddress: "localhost",
      bindPort: 15432,
      destHost: "db.internal",
      destPort: 5432,
    },
  ],
};

export const runState: RunState = {
  id: RUN,
  projectId: PROJECT_ID,
  boxId: box.id,
  container: CONTAINER,
  request: RunRequestSchema.parse({
    projectId: PROJECT_ID,
    boxId: box.id,
    repoPath: box.worktree,
    tip: "claude/emails",
  }),
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
  updatedAt: T1,
};

export const policyResult = {
  path: "/work/example-app/.aio/policy.yaml",
  exists: false,
  policy: DEFAULT_POLICY,
};
