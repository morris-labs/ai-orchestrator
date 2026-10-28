// Builders for valid contract objects, for tests and the fake server.
import {
  DEFAULT_PROMPT_TEMPLATES,
  defaultConfig,
  deriveHostKey,
  projectContainerName,
  type AgentBoxEvent,
  type Box,
  type BoxView,
  type EventOf,
  type EventType,
  type GlobalSettings,
  type Job,
  type Project,
} from "@agentbox/contracts";

export const T0 = "2026-10-28T09:00:00Z";

/** A project id for a root: `slug-<8 hex>`; the hash is fake but well formed. */
export function projectIdFor(root: string): string {
  const base = root.split("/").filter(Boolean).pop() ?? "root";
  let h = 0;
  for (const c of root) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${base.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "p"}-${h.toString(16).padStart(8, "0").slice(-8)}`;
}

export function makeProject(partial: Partial<Project> & { root: string }): Project {
  const id = partial.id ?? projectIdFor(partial.root);
  return {
    id,
    name: partial.root.split("/").filter(Boolean).pop() ?? "project",
    tcpMaps: [],
    mounts: [],
    secretRefs: [],
    policyPath: ".claude-box/policy.yaml",
    createdAt: T0,
    updatedAt: T0,
    ...partial,
  };
}

export function makeBox(partial: Partial<Box> & { id: string; targetDir: string }): Box {
  const projectId = partial.projectId ?? projectIdFor(partial.targetDir);
  return {
    projectId,
    hostKey: deriveHostKey(partial.id),
    sessionUuid: null,
    conversationName: partial.id.replace(/^claude-agent-/, ""),
    transcriptSyncedName: "",
    platform: "claude",
    skipPermissions: true,
    container: projectContainerName(projectId),
    session: partial.id,
    wasRunning: false,
    sshRemoteRefs: [],
    createdAt: T0,
    updatedAt: T0,
    ...partial,
  };
}

export function makeBoxView(
  partial: Partial<Omit<BoxView, "box">> & {
    box: Partial<Box> & { id: string; targetDir: string };
  },
): BoxView {
  const box = makeBox(partial.box);
  const { box: _b, ...rest } = partial;
  return {
    box,
    status: "stopped",
    container: box.container,
    tmuxSession: box.session,
    reviewState: { state: "idle" },
    stats: null,
    listeners: [],
    proxyUrls: [],
    sideSessions: [],
    ...rest,
  };
}

export function makeJob(partial: Partial<Job> & { id: string; kind: Job["kind"] }): Job {
  return {
    boxId: null,
    command: partial.kind,
    status: "running",
    exitCode: null,
    error: null,
    result: null,
    startedAt: T0,
    finishedAt: null,
    ...partial,
  };
}

export function makeSettings(partial: Partial<GlobalSettings> = {}): GlobalSettings {
  return { ...defaultConfig(), setupCompleted: true, ...partial };
}

export { DEFAULT_PROMPT_TEMPLATES };

let eventCounter = 0;

/** Builds an event with its envelope; `seq` defaults to a counter. */
export function makeEvent<T extends EventType>(
  type: T,
  payload: Omit<EventOf<T>, "type" | "id" | "time" | "source" | "streamId" | "seq" | "sourceSeq"> &
    Partial<Pick<AgentBoxEvent, "streamId" | "seq">>,
): EventOf<T> {
  eventCounter += 1;
  const seq = payload.seq ?? eventCounter;
  return {
    id: `ev-${eventCounter}`,
    time: T0,
    source: "server",
    streamId: "stream-1",
    sourceSeq: seq,
    ...payload,
    seq,
    type,
  } as unknown as EventOf<T>;
}
