// An in-memory `Core` for the API tests. It keeps projects, boxes, settings,
// and SSH remotes in maps and records every call.
import { openDatabase } from "../../src/db/index.js";
import {
  parseConfig,
  type Box,
  type BoxView,
  type GlobalSettings,
  type SshRemote,
} from "@agentbox/contracts";
import type { Core, EngineEndpoint } from "../../src/api/core-interface.js";
import { ApiFailure } from "../../src/api/errors.js";
import {
  CONTAINER,
  T1,
  UUID,
  box as boxFixture,
  policyResult,
  project,
  projectSummary,
  sshRemote,
  viewOf,
} from "./fixtures.js";

export interface FakeCore extends Core {
  calls: string[];
  views: Map<string, BoxView>;
  remotes: Map<string, SshRemote>;
  endpoints: EngineEndpoint[];
  settingsValue: GlobalSettings;
}

function notFound(what: string): never {
  throw new ApiFailure("not_found", `No ${what}.`);
}

export function createFakeCore(): FakeCore {
  const calls: string[] = [];
  const views = new Map<string, BoxView>([[boxFixture.id, viewOf(boxFixture)]]);
  const remotes = new Map<string, SshRemote>([[sshRemote.name, sshRemote]]);
  const state = { settings: parseConfig({}) };
  const view = (id: string) => views.get(id) ?? notFound(`box ${id}`);
  const record = (name: string) => calls.push(name);
  const bulk = { done: [boxFixture.id], failed: [] };

  const core: FakeCore = {
    calls,
    views,
    remotes,
    endpoints: [],
    get settingsValue() {
      return state.settings;
    },
    db: openDatabase(":memory:"),
    docker: {
      api: {} as Core["docker"]["api"],
      ping: async () => true,
      refreshStats: async () => void record("docker.refreshStats"),
    },
    image: {
      status: async () => ({
        name: "claude-code",
        exists: true,
        imageId: "sha256:abc",
        createdAt: T1,
        engineVersion: "4.0.0-dev",
        expectedEngineVersion: "4.0.0-dev",
        engineMatches: true,
        cliVersions: { claude: "2.1.300", codex: null, copilot: null },
      }),
    },
    projects: {
      list: async () => [projectSummary],
      create: async (input) => {
        record("projects.create");
        if (input.root === project.root) throw new ApiFailure("conflict", "Already a project.");
        return { ...project, root: input.root, name: input.name ?? "new" };
      },
      get: async (id) => (id === project.id ? projectSummary : notFound(`project ${id}`)),
      update: async (id, patch) => {
        record("projects.update");
        if (id !== project.id) notFound(`project ${id}`);
        return { project: { ...project, name: patch.name ?? project.name }, staleBoxes: [] };
      },
      restartContainer: async () => (record("projects.restartContainer"), bulk),
      getPolicy: async () => policyResult,
      putPolicy: async (_id, policy) => ({ ...policyResult, exists: true, policy }),
    },
    boxes: {
      list: async (q) =>
        [...views.values()].filter(
          (v) => q.projectId === undefined || v.box.projectId === q.projectId,
        ),
      get: async (id) => view(id),
      validateCreate: async (input) => {
        record("boxes.validateCreate");
        if (input.conversation.mode === "adopt" && input.conversation.sessionUuid === UUID) {
          throw new ApiFailure("adoption_refused", "A running box holds that session.");
        }
      },
      create: async (input, log) => {
        log("Creating\r\n");
        const b: Box = {
          ...boxFixture,
          id: "claude-agent-new",
          hostKey: "new",
          conversationName: input.conversationName,
        };
        views.set(b.id, viewOf(b, "starting"));
        return b;
      },
      update: async (id, patch) => ({
        box: {
          ...view(id),
          box: { ...view(id).box, conversationName: patch.conversationName ?? "" },
        },
        restartRequired: patch.sessionUuid !== undefined,
      }),
      start: async (id, options) => {
        if (options?.force) record(`start:force:${id}`);
        if (view(id).status === "running") throw new ApiFailure("box_running", "Already running.");
        return { ...view(id), status: "starting" };
      },
      stop: async (id) => ({ ...view(id), status: "stopping" }),
      restart: async (id) => view(id),
      remove: async (id) => {
        if (view(id).status === "running") throw new ApiFailure("box_running", "Stop it first.");
        views.delete(id);
        return { removed: true, worktree: "none", reason: null };
      },
      purge: async (id, options) => ({
        dryRun: options?.dryRun ?? false,
        removedRecords: [id],
        removedTranscriptDirs: [],
      }),
      move: async (id) => ({ movedBoxes: [id] }),
      relink: async (id, targetDir) => ({ ...view(id), box: { ...view(id).box, targetDir } }),
      validateConvertToWorktree: async (id) => void view(id),
      planConvertToWorktree: async (id) => {
        record(`plan:${view(id).box.id}`);
        return { report: "Worktree:    /work/example-app/.worktrees/emails", buildOutputBytes: 0 };
      },
      convertToWorktree: async (id) => ({
        box: view(id).box,
        worktree: "/work/example-app/.worktrees/emails",
        branch: "claude/emails",
        oldFolder: "/work/example-app/emails.pre-worktree",
        recordBackup: "/home/user/.claude-box/backup/x",
        keptRefs: [],
        notCarried: [],
      }),
      startSideSession: async (id, platform) => ({
        session: `${view(id).tmuxSession}-${platform}`,
      }),
      stopSideSession: async (id, platform) => void record(`stopSide:${id}:${platform}`),
      setPlatform: async (id, platform) => ({ ...view(id), box: { ...view(id).box, platform } }),
      message: async (id, text) => void record(`message:${id}:${text.slice(0, 20)}`),
      startAll: async () => bulk,
      stopAll: async () => bulk,
      restartAll: async () => bulk,
    },
    catalog: {
      list: async (dir) => ({
        dir,
        conversations: [
          {
            sessionUuid: UUID,
            title: "Emails",
            titleSource: "custom-title",
            turns: 3,
            modifiedAt: T1,
            sizeBytes: 100,
            lastPrompt: "Fix it",
            trackedBy: [boxFixture.id],
          },
        ],
      }),
    },
    models: {
      list: async () => ({
        models: ["claude-opus-5-5"],
        efforts: ["low", "medium", "high"],
        defaults: { model: "claude-opus-5-5", effort: "high" },
        source: "baseline",
      }),
      rescan: async () => {
        throw new ApiFailure("image_missing", "Build the image first.");
      },
    },
    settings: {
      get: () => state.settings,
      patch: async (p) => {
        state.settings = {
          ...state.settings,
          ...(p.engineImage ? { engineImage: p.engineImage } : {}),
          notifications: { ...state.settings.notifications, ...p.notifications },
        };
        return state.settings;
      },
      setPromptTemplates: async (t) => (state.settings = { ...state.settings, promptTemplates: t }),
      setGlobalMounts: async (mounts) => {
        state.settings = { ...state.settings, globalMounts: mounts };
        return { mounts, staleContainers: [CONTAINER] };
      },
      setSecretRefs: async (refs) => (state.settings = { ...state.settings, secretRefs: refs }),
      completeSetup: async (input) =>
        (state.settings = {
          ...state.settings,
          setupCompleted: true,
          ...(input.defaultTargetDir ? { defaultTargetDir: input.defaultTargetDir } : {}),
        }),
    },
    sshRemotes: {
      list: async () => [...remotes.values()],
      get: async (name) => remotes.get(name) ?? notFound(`remote ${name}`),
      put: async (name, remote) => {
        if (remote.name !== name && remotes.has(remote.name))
          throw new ApiFailure("conflict", "Taken.");
        remotes.delete(name);
        remotes.set(remote.name, remote);
        return remote;
      },
      delete: async (name) => {
        remotes.delete(name);
        return { unlinkedBoxes: [boxFixture.id] };
      },
    },
    engines: { list: async () => core.endpoints },
    legacyImport: {
      run: async ({ dryRun }) => {
        record(`import:${dryRun}`);
        return {
          dryRun,
          projects: 1,
          boxes: 2,
          sshRemotes: 0,
          settingsApplied: true,
          warnings: [],
        };
      },
    },
  };
  return core;
}
