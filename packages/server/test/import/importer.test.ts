import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_TEMPLATES,
  ImportReportSchema,
  projectContainerName,
} from "@agentbox/contracts";
import { openDatabase, repositories, type Repositories } from "../../src/db/index.js";
import {
  IMPORT_SOURCE,
  needsImport,
  parseForward,
  runImport,
  summarizeImport,
} from "../../src/import/index.js";
import { projectIdForRoot } from "../../src/projects/ids.js";
import type { HostEnv } from "../../src/records/env.js";

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = new Date("2026-10-28T12:00:00Z");

interface Fixture {
  env: HostEnv;
  home: string;
  app: string;
  loose: string;
  appId: string;
  looseId: string;
  conf: string;
  files: string[];
}

function write(file: string, lines: string[], files: string[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  files.push(file);
}

function buildFixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "import-home-"));
  const files: string[] = [];
  const app = path.join(home, "work", "my.app");
  const loose = path.join(home, "work", "loose");
  fs.mkdirSync(path.join(app, ".git"), { recursive: true });
  fs.mkdirSync(loose, { recursive: true });
  const appId = projectIdForRoot(app);
  const looseId = projectIdForRoot(loose);
  const data = path.join(home, ".claude-box");
  const known = (name: string, lines: string[]) =>
    write(path.join(data, "known", name), lines, files);

  write(
    path.join(data, "projects", appId),
    [
      `root=${app}`,
      "name=My App",
      "shared_container=0",
      "port=20000:20000",
      "port=20001:20001",
      `dir=${home}/data:/data`,
      `dir=${home}/cache`,
    ],
    files,
  );
  // A project file whose name does not match its root is ignored.
  write(path.join(data, "projects", "bogus-00000000"), [`root=${app}`], files);

  known("claude-agent-classic", [
    `target_dir=${app}`,
    `session_uuid=${UUID_A}`,
    "conversation_name=classic",
    "transcript_synced_name=classic",
    "launched_model=claude-opus-5-5",
    "launched_effort=high",
    "yolo=1",
    "model=claude-opus-5-5",
    "effort=high",
    "port=20000:20000",
    "port=8080:3000",
    `dir=${home}/extra:/extra`,
    `dir=${home}/other:/data`,
    "rc=1",
    "was_running=1",
  ]);
  known("claude-agent-shared.x", [
    `target_dir=${app}/`,
    `session_uuid=${UUID_B}`,
    "conversation_name=Shared one",
    "transcript_synced_name=",
    `container=${projectContainerName(appId)}`,
    "session=shared.x",
    "port=20001:20001",
    "port=8080:3000",
    "port=8081:4000",
    "was_running=0",
  ]);
  known("claude-agent-loose", [
    `target_dir=${loose}`,
    "session_uuid=",
    "conversation_name=",
    "transcript_synced_name=",
    "yolo=0",
    "port=9000:9000",
    "port=9000:9001",
    "port=bad",
  ]);
  known("claude-agent-tree", [
    `target_dir=${app}`,
    `session_uuid=${UUID_A}`,
    "conversation_name=tree",
    "transcript_synced_name=tree",
    `worktree=${app}/.worktrees/tree`,
    "branch=claude/tree",
    `moved_from=${app}/tree`,
    `container=claude-agent-proj-elsewhere-12345678`,
    "session=tree",
  ]);
  known("claude-agent-codex", [
    `target_dir=${loose}`,
    "session_uuid=not-a-uuid",
    "conversation_name=codex",
    "transcript_synced_name=",
    "platform=codex",
    "yolo=0",
    "effort=turbo",
    "launched_effort=extreme",
  ]);
  known("claude-agent-legacyflat", [
    `target_dir=${loose}`,
    "session_uuid=",
    "conversation_name=flat",
    "transcript_synced_name=",
    "ssh_host=me@example.com:2222",
    "ssh_identity=/keys/id",
    "ssh_forward=L::5432:db.example.com:5432",
    "ssh_forward=X:bad",
  ]);
  known("claude-agent-legacyidx", [
    `target_dir=${loose}`,
    "session_uuid=",
    "conversation_name=idx",
    "transcript_synced_name=",
    "ssh_remote_ref=prod",
    "ssh_remote=0|ops@203.0.113.5",
    "ssh_forward=0|R:127.0.0.1:9000:localhost:3000",
    "ssh_remote=1|",
  ]);
  known("not-a-box", ["target_dir=/x"]);
  known("claude-agent-notarget", ["conversation_name=x"]);

  write(
    path.join(data, "ssh_remotes", "prod"),
    [
      "name=prod",
      "host=deploy@198.51.100.7",
      "identity=/keys/prod",
      "forward=L:localhost:8443:internal:443",
    ],
    files,
  );
  write(
    path.join(data, "global"),
    [`dir=${home}/shared`, `dir=${home}/tools:/opt/tools`, "junk"],
    files,
  );

  const conf = path.join(home, ".config", "claude-box", "claude-box.conf");
  write(
    conf,
    [
      "[models]",
      "imageId=sha256:abc",
      "scan=claude-opus-5-5, claude-sonnet-5-5",
      "scanTime=1790000000",
      "",
      "[newBox]",
      `workspaceDirs=${loose}, !${app}`,
      `worktreeDirs=!${app}`,
      "",
      "[prompts]",
      'starter="Say \\"hi\\", then\\nread CLAUDE.md."',
      "worktree=Tree %1\\nline two",
      "",
      "[setup]",
      "completed=true",
      `defaultTargetDir=${home}/work`,
      "sshIdentity=/keys/id_ed25519",
      "",
      "[ui]",
      "geometry=@ByteArray(xyz)",
      "[portAllocator]",
      "nextBase=20010",
    ],
    files,
  );
  return {
    env: { home, user: "dev", now: () => NOW },
    home,
    app,
    loose,
    appId,
    looseId,
    conf,
    files,
  };
}

function snapshot(files: string[]) {
  return files.map((f) => ({ f, bytes: fs.readFileSync(f), mtime: fs.statSync(f).mtimeMs }));
}

describe("runImport", () => {
  let fx: Fixture;
  let repos: Repositories;

  beforeEach(() => {
    fx = buildFixture();
    repos = repositories(openDatabase(":memory:"));
  });

  it("knows when an import is needed", () => {
    expect(needsImport(fx.env, repos)).toBe(true);
    runImport({ env: fx.env, repos });
    expect(needsImport(fx.env, repos)).toBe(false);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "import-empty-"));
    expect(needsImport({ ...fx.env, home: empty }, repositories(openDatabase(":memory:")))).toBe(
      false,
    );
  });

  it("imports projects with mounts, tcp maps, and the pool dropped", () => {
    const report = runImport({ env: fx.env, repos });
    const app = repos.projects.get(fx.appId);
    expect(app).toMatchObject({
      id: fx.appId,
      root: fx.app,
      name: "My App",
      primaryRepo: fx.app,
      secretRefs: [],
      policyPath: ".claude-box/policy.yaml",
    });
    expect(app?.mounts).toEqual([
      { host: `${fx.home}/data`, container: "/data" },
      { host: `${fx.home}/cache`, container: `${fx.home}/cache` },
      { host: `${fx.home}/extra`, container: "/extra" },
    ]);
    expect(app?.tcpMaps).toEqual([
      { host: 8080, container: 3000 },
      { host: 8081, container: 4000 },
    ]);
    const loose = repos.projects.get(fx.looseId);
    expect(loose).toMatchObject({
      root: fx.loose,
      name: "loose",
      tcpMaps: [{ host: 9000, container: 9000 }],
    });
    expect(loose?.primaryRepo).toBeUndefined();

    expect(report.projects.imported.sort()).toEqual([fx.appId, fx.looseId].sort());
    expect(report.projects.implicit).toEqual([fx.looseId]);
    expect(report.poolPortsDropped).toEqual([
      { projectId: fx.appId, boxId: null, port: "20000:20000" },
      { projectId: fx.appId, boxId: null, port: "20001:20001" },
      { projectId: fx.appId, boxId: "claude-agent-classic", port: "20000:20000" },
      { projectId: fx.appId, boxId: "claude-agent-shared.x", port: "20001:20001" },
    ]);
    expect(report.tcpMapsAdded).toEqual([
      { projectId: fx.appId, boxId: "claude-agent-classic", host: 8080, container: 3000 },
      { projectId: fx.looseId, boxId: "claude-agent-loose", host: 9000, container: 9000 },
      { projectId: fx.appId, boxId: "claude-agent-shared.x", host: 8081, container: 4000 },
    ]);
    expect(report.mountsSkipped).toEqual([
      {
        projectId: fx.appId,
        from: "claude-agent-classic",
        mount: `${fx.home}/other:/data`,
        reason: `container path /data is already mounted from ${fx.home}/data`,
      },
    ]);
    expect(report.warnings.some((w) => w.includes("bogus-00000000"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("9000:9001") && w.includes("conflicts"))).toBe(
      true,
    );
    expect(report.warnings.some((w) => w.includes("invalid port bad"))).toBe(true);
  });

  it("imports every box field", () => {
    const report = runImport({ env: fx.env, repos });
    const container = projectContainerName(fx.appId);
    const classic = repos.boxes.get("claude-agent-classic");
    const mtime = fs
      .statSync(path.join(fx.home, ".claude-box/known/claude-agent-classic"))
      .mtime.toISOString();
    expect(classic).toEqual({
      id: "claude-agent-classic",
      projectId: fx.appId,
      hostKey: "classic",
      targetDir: fx.app,
      sessionUuid: UUID_A,
      conversationName: "classic",
      transcriptSyncedName: "classic",
      platform: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      skipPermissions: true,
      container,
      session: "claude-agent-classic",
      launchedModel: "claude-opus-5-5",
      launchedEffort: "high",
      wasRunning: true,
      sshRemoteRefs: [],
      createdAt: mtime,
      updatedAt: mtime,
    });
    const shared = repos.boxes.get("claude-agent-shared.x");
    expect(shared).toMatchObject({
      targetDir: `${fx.app}/`,
      projectId: fx.appId,
      container,
      session: "shared.x",
      hostKey: "shared-x",
      skipPermissions: true,
      wasRunning: false,
      conversationName: "Shared one",
    });
    expect(repos.boxes.get("claude-agent-loose")).toMatchObject({
      projectId: fx.looseId,
      sessionUuid: null,
      skipPermissions: false,
      session: "claude-agent-loose",
      container: projectContainerName(fx.looseId),
    });
    const tree = repos.boxes.get("claude-agent-tree");
    expect(tree).toMatchObject({
      worktree: `${fx.app}/.worktrees/tree`,
      branch: "claude/tree",
      movedFrom: `${fx.app}/tree`,
      container,
      session: "tree",
    });
    expect(
      report.warnings.some((w) => w.includes("claude-agent-tree") && w.includes("elsewhere")),
    ).toBe(true);
    const codex = repos.boxes.get("claude-agent-codex");
    expect(codex).toMatchObject({ platform: "codex", skipPermissions: false, sessionUuid: null });
    expect(codex?.effort).toBeUndefined();
    expect(codex?.launchedEffort).toBeUndefined();
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        "claude-agent-codex: dropped the invalid session_uuid not-a-uuid.",
        "claude-agent-codex: dropped the invalid effort turbo.",
        "claude-agent-codex: dropped the invalid launched_effort extreme.",
      ]),
    );
    expect(report.boxes.skipped).toEqual([
      { file: "claude-agent-notarget", reason: "the record has no target_dir" },
      { file: "not-a-box", reason: "the name does not start with claude-agent-" },
    ]);
    expect(report.boxes.imported).toHaveLength(7);

    // Host keys are unique within each project.
    for (const id of [fx.appId, fx.looseId]) {
      const keys = repos.boxes.byProject(id).map((b) => b.hostKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("converts legacy inline remotes and imports named ones", () => {
    const report = runImport({ env: fx.env, repos });
    expect(repos.sshRemotes.get("claude-agent-legacyflat-0")).toEqual({
      name: "claude-agent-legacyflat-0",
      host: "me@example.com:2222",
      identity: "/keys/id",
      forwards: [
        {
          direction: "L",
          bindAddress: "localhost",
          bindPort: 5432,
          destHost: "db.example.com",
          destPort: 5432,
        },
      ],
    });
    expect(repos.sshRemotes.get("claude-agent-legacyidx-0")).toEqual({
      name: "claude-agent-legacyidx-0",
      host: "ops@203.0.113.5",
      forwards: [
        {
          direction: "R",
          bindAddress: "127.0.0.1",
          bindPort: 9000,
          destHost: "localhost",
          destPort: 3000,
        },
      ],
    });
    expect(repos.sshRemotes.get("prod")).toEqual({
      name: "prod",
      host: "deploy@198.51.100.7",
      identity: "/keys/prod",
      forwards: [
        {
          direction: "L",
          bindAddress: "localhost",
          bindPort: 8443,
          destHost: "internal",
          destPort: 443,
        },
      ],
    });
    expect(repos.boxes.get("claude-agent-legacyflat")?.sshRemoteRefs).toEqual([
      "claude-agent-legacyflat-0",
    ]);
    expect(repos.boxes.get("claude-agent-legacyidx")?.sshRemoteRefs).toEqual([
      "prod",
      "claude-agent-legacyidx-0",
    ]);
    expect(report.sshRemotes.legacyConverted).toEqual([
      { boxId: "claude-agent-legacyflat", remote: "claude-agent-legacyflat-0" },
      { boxId: "claude-agent-legacyidx", remote: "claude-agent-legacyidx-0" },
    ]);
    expect(report.sshRemotes.imported).toEqual([
      "prod",
      "claude-agent-legacyflat-0",
      "claude-agent-legacyidx-0",
    ]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        "claude-agent-legacyflat: skipped the invalid SSH forward X:bad.",
        "claude-agent-legacyidx: skipped inline SSH remote 1: it has no host.",
      ]),
    );
  });

  it("imports the settings from the global file and QSettings", () => {
    const report = runImport({ env: fx.env, repos });
    const s = repos.settings.get();
    expect(s.globalMounts).toEqual([
      { host: `${fx.home}/shared`, container: `${fx.home}/shared` },
      { host: `${fx.home}/tools`, container: "/opt/tools" },
    ]);
    expect(s.promptTemplates).toEqual({
      workspace: DEFAULT_PROMPT_TEMPLATES.workspace,
      portHint: DEFAULT_PROMPT_TEMPLATES.portHint,
      worktree: "Tree %1\nline two",
      starter: 'Say "hi", then\nread CLAUDE.md.',
    });
    expect(s.setupCompleted).toBe(true);
    expect(s.defaultTargetDir).toBe(`${fx.home}/work`);
    expect(s.sshIdentity).toBe("/keys/id_ed25519");
    expect(s.modelCache).toEqual({
      imageId: "sha256:abc",
      scannedAt: new Date(1790000000 * 1000).toISOString(),
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
    });
    expect(s.newBoxDefaults).toEqual({
      workspaceDirs: { [fx.loose]: true, [fx.app]: false },
      worktreeDirs: { [fx.app]: false },
    });
    expect(report.settingsApplied.sort()).toEqual(
      [
        "defaultTargetDir",
        "globalMounts",
        "modelCache",
        "newBoxDefaults",
        "promptTemplates",
        "setupCompleted",
        "sshIdentity",
      ].sort(),
    );
  });

  it("saves and writes the report and never touches the sources", () => {
    const before = snapshot(fx.files);
    const report = runImport({ env: fx.env, repos });
    expect(snapshot(fx.files)).toEqual(before);
    const written = JSON.parse(
      fs.readFileSync(path.join(fx.home, ".claude-box/import-report.json"), "utf8"),
    );
    expect(written).toEqual(JSON.parse(JSON.stringify(report)));
    expect(repos.imports.latest(IMPORT_SOURCE)?.report).toEqual(JSON.parse(JSON.stringify(report)));
    expect(report.filesRead).toContain(fx.conf);
  });

  it("reports a dry run and changes nothing", () => {
    const report = runImport({ env: fx.env, repos, dryRun: true });
    expect(report.boxes.imported).toHaveLength(7);
    expect(repos.boxes.list()).toEqual([]);
    expect(repos.projects.list()).toEqual([]);
    expect(repos.imports.latest(IMPORT_SOURCE)).toBeUndefined();
    expect(fs.existsSync(path.join(fx.home, ".claude-box/import-report.json"))).toBe(false);
    expect(needsImport(fx.env, repos)).toBe(true);

    const summary = ImportReportSchema.parse(summarizeImport(report, true));
    expect(summary).toMatchObject({
      dryRun: true,
      projects: report.projects.imported.length,
      boxes: 7,
      sshRemotes: report.sshRemotes.imported.length,
      settingsApplied: true,
    });
    expect(summary.warnings.length).toBeGreaterThanOrEqual(report.warnings.length);
  });

  it("skips a map whose container port is taken or is the engine's", () => {
    const data = path.join(fx.home, ".claude-box", "known");
    write(
      path.join(data, "claude-agent-twin"),
      [`target_dir=${fx.loose}`, "port=9100:9000", "port=9200:20411"],
      fx.files,
    );
    const report = runImport({ env: fx.env, repos });
    expect(repos.projects.get(fx.looseId)?.tcpMaps).toEqual([{ host: 9000, container: 9000 }]);
    expect(report.tcpMapsAdded.filter((t) => t.boxId === "claude-agent-twin")).toEqual([]);
    expect(report.warnings.some((w) => w.includes("9100:9000") && w.includes("same container"))).toBe(
      true,
    );
    expect(report.warnings.some((w) => w.includes("9200:20411") && w.includes("engine"))).toBe(
      true,
    );
  });

  it("merges a later box's maps and mounts into a project that exists", () => {
    runImport({ env: fx.env, repos });
    const data = path.join(fx.home, ".claude-box", "known");
    fs.mkdirSync(path.join(fx.home, "late"), { recursive: true });
    write(
      path.join(data, "claude-agent-late"),
      [`target_dir=${fx.loose}`, "port=9300:7000", `dir=${fx.home}/late:/late`],
      fx.files,
    );
    const second = runImport({ env: fx.env, repos });
    expect(second.boxes.imported).toEqual(["claude-agent-late"]);
    expect(second.tcpMapsAdded).toEqual([
      { projectId: fx.looseId, boxId: "claude-agent-late", host: 9300, container: 7000 },
    ]);
    const loose = repos.projects.get(fx.looseId);
    expect(loose?.tcpMaps).toEqual([
      { host: 9000, container: 9000 },
      { host: 9300, container: 7000 },
    ]);
    expect(loose?.mounts).toContainEqual({ host: `${fx.home}/late`, container: "/late" });
    expect(second.mountsSkipped).toEqual([]);
  });

  it("changes nothing on a second run", () => {
    runImport({ env: fx.env, repos });
    const dump = () => ({
      projects: repos.projects.list(),
      boxes: repos.boxes.list(),
      remotes: repos.sshRemotes.list(),
      settings: repos.settings.get(),
    });
    const first = dump();
    // A later edit to the settings survives a second import.
    repos.settings.put({ ...first.settings, setupCompleted: false }, NOW);
    const second = runImport({ env: fx.env, repos });
    expect(dump()).toEqual({ ...first, settings: { ...first.settings, setupCompleted: false } });
    expect(second.boxes.imported).toEqual([]);
    expect(second.boxes.alreadyPresent).toHaveLength(7);
    expect(second.projects.imported).toEqual([]);
    expect(second.projects.alreadyPresent.sort()).toEqual([fx.appId, fx.looseId].sort());
    expect(second.sshRemotes.imported).toEqual([]);
    expect(second.sshRemotes.alreadyPresent).toEqual(["prod"]);
    expect(second.settingsApplied).toEqual([]);

    const forced = runImport({ env: fx.env, repos, force: true });
    expect(forced.settingsApplied.length).toBeGreaterThan(0);
    expect(repos.settings.get().setupCompleted).toBe(true);
    expect(repos.boxes.list()).toEqual(first.boxes);
  });
});

describe("parseForward", () => {
  it("parses both directions and refuses bad specs", () => {
    expect(parseForward("L::80:web:8080")).toEqual({
      direction: "L",
      bindAddress: "localhost",
      bindPort: 80,
      destHost: "web",
      destPort: 8080,
    });
    expect(parseForward("R:0.0.0.0:1:h:2")?.direction).toBe("R");
    expect(parseForward("L:a:0:h:2")).toBeUndefined();
    expect(parseForward("L:a:1:h")).toBeUndefined();
    expect(parseForward("Q:a:1:h:2")).toBeUndefined();
    expect(parseForward("L:a:1::2")).toBeUndefined();
  });
});
