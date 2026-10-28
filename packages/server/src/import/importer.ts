// The one-time import of the 3.3.5 state (`~/.claude-box/known`, `projects`,
// `global`, `ssh_remotes`, and the QSettings file) into the database. It
// follows the mapping table and import rules at the top of
// `packages/contracts/src/records.ts`. It never changes or deletes a source
// file, and records already in the database are left as they are.
import fs from "node:fs";
import path from "node:path";
import {
  BoxInputSchema,
  EffortSchema,
  PlatformSchema,
  ProjectInputSchema,
  SshRemoteInputSchema,
  projectContainerName,
  type Box,
  type GlobalSettings,
  type Mount,
  type Project,
  type SshForward,
  type SshRemote,
  type TcpMap,
  type ImportReport as ContractImportReport,
} from "@agentbox/contracts";
import type { Repositories } from "../db/repositories.js";
import { allocateHostKey } from "../records/box.js";
import { homePaths, hostToContainer, splitMountSpec, type HostEnv } from "../records/env.js";
import {
  defaultProjectName,
  detectPrimaryRepo,
  normalizeRoot,
  projectIdForRoot,
} from "../projects/ids.js";
import { kvAll, kvLast, readKvFile } from "./kv.js";
import { qtBool, qtList, qtString, readQtIni, type QtValue } from "./qsettings.js";

/** The `imports.source` value for this import. */
export const IMPORT_SOURCE = "claude-box-3";

export interface ImportReport {
  /** The `~/.claude-box` directory read. */
  source: string;
  /** The QSettings file read, whether or not it exists. */
  confPath: string;
  startedAt: string;
  finishedAt: string;
  /** Every source file read. */
  filesRead: string[];
  projects: {
    imported: string[];
    alreadyPresent: string[];
    /** Imported projects that had no `projects/` file, created for a box's directory. */
    implicit: string[];
  };
  boxes: {
    imported: string[];
    alreadyPresent: string[];
    skipped: { file: string; reason: string }[];
  };
  sshRemotes: {
    imported: string[];
    alreadyPresent: string[];
    /** Inline remotes from box records, imported as named remotes. */
    legacyConverted: { boxId: string; remote: string }[];
  };
  /** Top-level `GlobalSettings` fields set from the 3.3.5 sources. */
  settingsApplied: string[];
  tcpMapsAdded: { projectId: string; boxId: string; host: number; container: number }[];
  /** Ports dropped because they belong to the project's port pool; `boxId` is null for the project file's own pool. */
  poolPortsDropped: { projectId: string; boxId: string | null; port: string }[];
  mountsSkipped: { projectId: string; from: string; mount: string; reason: string }[];
  warnings: string[];
}

export interface ImportOptions {
  env: HostEnv;
  repos: Repositories;
  /** Defaults to `~/.config/claude-box/claude-box.conf`. */
  confPath?: string;
  /** Applies the settings again even when an earlier import did. */
  force?: boolean;
  /**
   * Reports what the import would apply and changes nothing: the database
   * transaction rolls back, and no report file is written.
   */
  dryRun?: boolean;
}

/** Thrown inside the import transaction to roll a dry run back. */
class DryRunRollback extends Error {}

interface ProjectDraft {
  id: string;
  root: string;
  name: string;
  primaryRepo?: string;
  poolHostPorts: Set<number>;
  mounts: Mount[];
  tcpMaps: TcpMap[];
  createdAt: string;
  implicit: boolean;
}

function sourceDirs(env: HostEnv) {
  const data = homePaths(env).dataDir;
  return {
    data,
    known: path.join(data, "known"),
    projects: path.join(data, "projects"),
    global: path.join(data, "global"),
    sshRemotes: path.join(data, "ssh_remotes"),
  };
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** True when a 3.3.5 source exists and no import has run yet. */
export function needsImport(env: HostEnv, repos: Repositories): boolean {
  const d = sourceDirs(env);
  const any = [d.known, d.projects, d.global, d.sshRemotes].some((p) => fs.existsSync(p));
  return any && repos.imports.latest(IMPORT_SOURCE) === undefined;
}

/** Parses a `HOST[:CONTAINER]` mount; the container side defaults to the host path. */
function parseMount(spec: string): Mount | undefined {
  const { host, container } = splitMountSpec(spec);
  if (host.trim() === "") return undefined;
  const hostAbs = path.resolve(host);
  return { host: hostAbs, container: path.posix.normalize(container || hostToContainer(hostAbs)) };
}

function parsePort(spec: string): TcpMap | undefined {
  const m = /^\s*(\d+):(\d+)\s*$/.exec(spec);
  if (!m) return undefined;
  const host = Number(m[1]);
  const container = Number(m[2]);
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
  return ok(host) && ok(container) ? { host, container } : undefined;
}

function poolHostPort(spec: string): number | undefined {
  const colon = spec.indexOf(":");
  const n = Number((colon >= 0 ? spec.slice(0, colon) : spec).trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parses `L|R:bindAddr:bindPort:destHost:destPort`; an empty bind address becomes `localhost`. */
export function parseForward(spec: string): SshForward | undefined {
  const parts = spec.split(":");
  if (parts.length !== 5) return undefined;
  const [dir, bind, bindPort, destHost, destPort] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (dir !== "L" && dir !== "R") return undefined;
  const bp = Number(bindPort);
  const dp = Number(destPort);
  const ok = (n: number) => /^\d+$/.test(String(n)) && n >= 1 && n <= 65535;
  if (!ok(bp) || !ok(dp) || destHost === "") return undefined;
  return {
    direction: dir,
    bindAddress: bind === "" ? "localhost" : bind,
    bindPort: bp,
    destHost,
    destPort: dp,
  };
}

function mtimeIso(file: string, fallback: Date): string {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return fallback.toISOString();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Imports the 3.3.5 records and settings into the database in one
 * transaction, saves the report in the `imports` table, and writes it to
 * `~/.claude-box/import-report.json`.
 */
export function runImport(options: ImportOptions): ImportReport {
  const { env, repos } = options;
  const d = sourceDirs(env);
  const confPath =
    options.confPath ?? path.join(env.home, ".config", "claude-box", "claude-box.conf");
  const started = env.now();
  const report: ImportReport = {
    source: d.data,
    confPath,
    startedAt: started.toISOString(),
    finishedAt: started.toISOString(),
    filesRead: [],
    projects: { imported: [], alreadyPresent: [], implicit: [] },
    boxes: { imported: [], alreadyPresent: [], skipped: [] },
    sshRemotes: { imported: [], alreadyPresent: [], legacyConverted: [] },
    settingsApplied: [],
    tcpMapsAdded: [],
    poolPortsDropped: [],
    mountsSkipped: [],
    warnings: [],
  };
  const firstImport = repos.imports.latest(IMPORT_SOURCE) === undefined;

  try {
    repos.transaction(() => {
      applyImport();
      if (options.dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
    return report;
  }

  const reportFile = homePaths(env).importReport;
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;

  function applyImport(): void {
    // Projects that have a file.
    const drafts = new Map<string, ProjectDraft>();
    const addMount = (draft: ProjectDraft, mount: Mount, from: string, spec: string) => {
      const taken = draft.mounts.find((m) => m.container === mount.container);
      if (taken) {
        report.mountsSkipped.push({
          projectId: draft.id,
          from,
          mount: spec,
          reason:
            taken.host === mount.host
              ? "the project already has this mount"
              : `container path ${mount.container} is already mounted from ${taken.host}`,
        });
        return;
      }
      draft.mounts.push(mount);
    };

    for (const file of listFiles(d.projects)) {
      const full = path.join(d.projects, file);
      report.filesRead.push(full);
      const kv = readKvFile(full);
      const rootRaw = kvLast(kv, "root") ?? "";
      const root = normalizeRoot(rootRaw);
      if (root === "" || projectIdForRoot(root) !== file) {
        report.warnings.push(
          `Skipped project file ${file}: its root ${rootRaw || "(none)"} does not match its name.`,
        );
        continue;
      }
      const name = kvLast(kv, "name") ?? "";
      const primary = kvLast(kv, "primary_repo") ?? "";
      const draft: ProjectDraft = {
        id: file,
        root,
        name: name || defaultProjectName(root),
        primaryRepo: primary || detectPrimaryRepo(root),
        poolHostPorts: new Set(),
        mounts: [],
        tcpMaps: [],
        createdAt: mtimeIso(full, started),
        implicit: false,
      };
      for (const p of kvAll(kv, "port")) {
        const hp = poolHostPort(p);
        if (hp !== undefined) draft.poolHostPorts.add(hp);
        report.poolPortsDropped.push({ projectId: file, boxId: null, port: p });
      }
      for (const spec of kvAll(kv, "dir")) {
        const mount = parseMount(spec);
        if (!mount) {
          report.warnings.push(`Skipped an empty mount in project ${file}.`);
          continue;
        }
        addMount(draft, mount, "project", spec);
      }
      drafts.set(file, draft);
    }

    const projectFor = (targetDir: string): ProjectDraft => {
      const root = normalizeRoot(targetDir);
      const id = projectIdForRoot(root);
      let draft = drafts.get(id);
      if (!draft) {
        draft = {
          id,
          root,
          name: defaultProjectName(root),
          primaryRepo: detectPrimaryRepo(root),
          poolHostPorts: new Set(),
          mounts: [],
          tcpMaps: [],
          createdAt: started.toISOString(),
          implicit: true,
        };
        drafts.set(id, draft);
      }
      return draft;
    };

    // Boxes.
    const boxes: Box[] = [];
    const remotes: SshRemote[] = [];
    const named: SshRemote[] = [];
    for (const file of listFiles(d.known)) {
      const full = path.join(d.known, file);
      report.filesRead.push(full);
      const kv = readKvFile(full);
      const skip = (reason: string) => report.boxes.skipped.push({ file, reason });
      if (!file.startsWith("claude-agent-")) {
        skip("the name does not start with claude-agent-");
        continue;
      }
      const targetDir = kvLast(kv, "target_dir") ?? "";
      if (targetDir.trim() === "") {
        skip("the record has no target_dir");
        continue;
      }
      const draft = projectFor(targetDir);
      if (repos.boxes.get(file)) {
        report.boxes.alreadyPresent.push(file);
        continue;
      }
      const warn = (msg: string) => report.warnings.push(`${file}: ${msg}`);
      const value = (key: string) => {
        const v = kvLast(kv, key);
        return v === undefined || v === "" ? undefined : v;
      };

      // Container and session (`adopt()` for a classic box).
      const container = projectContainerName(draft.id);
      const recContainer = value("container");
      const shared = recContainer !== undefined && recContainer !== file;
      if (shared && recContainer !== container) {
        warn(`its container ${recContainer} becomes ${container}.`);
      }
      const session = shared ? (value("session") ?? file) : file;

      let sessionUuid: string | null = value("session_uuid") ?? null;
      if (sessionUuid !== null && !UUID_RE.test(sessionUuid)) {
        warn(`dropped the invalid session_uuid ${sessionUuid}.`);
        sessionUuid = null;
      }
      const effortOf = (key: string) => {
        const v = value(key);
        if (v === undefined) return undefined;
        if (EffortSchema.safeParse(v).success) return v;
        warn(`dropped the invalid ${key} ${v}.`);
        return undefined;
      };
      let platform = value("platform") ?? "claude";
      if (!PlatformSchema.safeParse(platform).success) {
        warn(`unknown platform ${platform}; it becomes claude.`);
        platform = "claude";
      }

      // Ports: pool ports are dropped, others become project TCP maps.
      for (const spec of kvAll(kv, "port")) {
        const map = parsePort(spec);
        if (!map) {
          warn(`skipped the invalid port ${spec}.`);
          continue;
        }
        if (draft.poolHostPorts.has(map.host)) {
          report.poolPortsDropped.push({ projectId: draft.id, boxId: file, port: spec });
          continue;
        }
        const existing = draft.tcpMaps.find((t) => t.host === map.host);
        if (existing) {
          if (existing.container !== map.container) {
            warn(
              `port ${spec} conflicts with the project's map ${existing.host}:${existing.container}; skipped.`,
            );
          }
          continue;
        }
        draft.tcpMaps.push(map);
        report.tcpMapsAdded.push({ projectId: draft.id, boxId: file, ...map });
      }
      for (const spec of kvAll(kv, "dir")) {
        const mount = parseMount(spec);
        if (!mount) {
          warn("skipped an empty mount.");
          continue;
        }
        addMount(draft, mount, file, spec);
      }

      // Remotes: named references, then legacy inline remotes.
      const refs = [...kvAll(kv, "ssh_remote_ref")];
      const inline = new Map<number, { host: string; identity: string; forwards: string[] }>();
      const slot = (n: number) => {
        let r = inline.get(n);
        if (!r) inline.set(n, (r = { host: "", identity: "", forwards: [] }));
        return r;
      };
      for (const [k, v] of kv) {
        const bar = v.indexOf("|");
        const idx = bar >= 0 ? Number.parseInt(v.slice(0, bar), 10) || 0 : 0;
        const rest = bar >= 0 ? v.slice(bar + 1) : v;
        if (k === "ssh_remote") {
          if (bar >= 0) slot(idx).host = rest;
        } else if (k === "ssh_identity") slot(idx).identity = rest;
        else if (k === "ssh_forward") slot(idx).forwards.push(rest);
        else if (k === "ssh_host") slot(0).host = v;
      }
      for (const [n, r] of [...inline.entries()].sort((a, b) => a[0] - b[0])) {
        const name = `${file}-${n}`;
        if (r.host.trim() === "") {
          warn(`skipped inline SSH remote ${n}: it has no host.`);
          continue;
        }
        const forwards: SshForward[] = [];
        for (const f of r.forwards) {
          const parsed = parseForward(f);
          if (parsed) forwards.push(parsed);
          else warn(`skipped the invalid SSH forward ${f}.`);
        }
        remotes.push(
          SshRemoteInputSchema.parse({
            name,
            host: r.host,
            ...(r.identity ? { identity: r.identity } : {}),
            forwards,
          }),
        );
        report.sshRemotes.legacyConverted.push({ boxId: file, remote: name });
        if (!refs.includes(name)) refs.push(name);
      }

      const time = mtimeIso(full, started);
      // Host keys are unique across every project; the proxy resolves them so.
      const siblings = [...repos.boxes.list(), ...boxes];
      const input = {
        id: file,
        projectId: draft.id,
        hostKey: allocateHostKey(file, siblings),
        targetDir,
        sessionUuid,
        conversationName: kvLast(kv, "conversation_name") ?? "",
        transcriptSyncedName: kvLast(kv, "transcript_synced_name") ?? "",
        platform,
        model: value("model"),
        effort: effortOf("effort"),
        skipPermissions: kvLast(kv, "yolo") === undefined ? true : kvLast(kv, "yolo") === "1",
        workspace: value("workspace"),
        worktree: value("worktree"),
        branch: value("branch"),
        movedFrom: value("moved_from"),
        container,
        session,
        launchedModel: value("launched_model"),
        launchedEffort: effortOf("launched_effort"),
        wasRunning: kvLast(kv, "was_running") === "1",
        sshRemoteRefs: refs,
        createdAt: time,
        updatedAt: time,
      };
      const parsed = BoxInputSchema.safeParse(input);
      if (!parsed.success) {
        skip(
          `the record does not validate: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        );
        continue;
      }
      boxes.push(parsed.data);
    }

    // Named SSH remotes.
    for (const file of listFiles(d.sshRemotes)) {
      const full = path.join(d.sshRemotes, file);
      report.filesRead.push(full);
      const kv = readKvFile(full);
      const name = kvLast(kv, "name") ?? "";
      if (name === "") {
        report.warnings.push(`Skipped SSH remote file ${file}: it has no name.`);
        continue;
      }
      const forwards: SshForward[] = [];
      for (const f of kvAll(kv, "forward")) {
        const parsed = parseForward(f);
        if (parsed) forwards.push(parsed);
        else report.warnings.push(`SSH remote ${name}: skipped the invalid forward ${f}.`);
      }
      const identity = kvLast(kv, "identity");
      const parsed = SshRemoteInputSchema.safeParse({
        name,
        host: kvLast(kv, "host") ?? "",
        ...(identity ? { identity } : {}),
        forwards,
      });
      if (!parsed.success) {
        report.warnings.push(`Skipped SSH remote ${name}: it has no host.`);
        continue;
      }
      named.push(parsed.data);
    }

    // Write projects first: boxes reference them.
    for (const draft of [...drafts.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (repos.projects.get(draft.id)) {
        report.projects.alreadyPresent.push(draft.id);
        continue;
      }
      const project: Project = ProjectInputSchema.parse({
        id: draft.id,
        root: draft.root,
        name: draft.name,
        ...(draft.primaryRepo ? { primaryRepo: draft.primaryRepo } : {}),
        tcpMaps: draft.tcpMaps,
        mounts: draft.mounts,
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
      });
      repos.projects.put(project);
      report.projects.imported.push(draft.id);
      if (draft.implicit) report.projects.implicit.push(draft.id);
    }
    for (const box of boxes) {
      repos.boxes.put(box);
      report.boxes.imported.push(box.id);
    }
    const seenRemotes = new Set<string>();
    for (const remote of [...named, ...remotes]) {
      if (seenRemotes.has(remote.name)) continue;
      seenRemotes.add(remote.name);
      if (repos.sshRemotes.get(remote.name)) {
        report.sshRemotes.alreadyPresent.push(remote.name);
        continue;
      }
      repos.sshRemotes.put(remote);
      report.sshRemotes.imported.push(remote.name);
    }

    // Settings, once.
    if (firstImport || options.force) {
      const settings = importSettings(d.global, confPath, repos.settings.get(), report);
      repos.settings.put(settings, env.now());
    }
    report.finishedAt = env.now().toISOString();
    repos.imports.add(IMPORT_SOURCE, report, env.now());
  }
}

/**
 * The contract's `ImportReport` for `import.run`: counts of what was, or with
 * `dryRun` would be, imported, and one sentence per skipped or changed item.
 */
export function summarizeImport(report: ImportReport, dryRun: boolean): ContractImportReport {
  const warnings = [
    ...report.warnings,
    ...report.boxes.skipped.map((s) => `Skipped box ${s.file}: ${s.reason}.`),
    ...report.mountsSkipped.map(
      (m) => `Skipped mount ${m.mount} of project ${m.projectId} from ${m.from}: ${m.reason}.`,
    ),
    ...report.poolPortsDropped.map(
      (p) =>
        `Dropped pool port ${p.port} of project ${p.projectId}${p.boxId ? ` (box ${p.boxId})` : ""}.`,
    ),
  ];
  return {
    dryRun,
    projects: report.projects.imported.length,
    boxes: report.boxes.imported.length,
    sshRemotes: report.sshRemotes.imported.length,
    settingsApplied: report.settingsApplied.length > 0,
    warnings,
  };
}

function importSettings(
  globalFile: string,
  confPath: string,
  base: GlobalSettings,
  report: ImportReport,
): GlobalSettings {
  const s: GlobalSettings = structuredClone(base);
  const applied = new Set<string>();

  if (fs.existsSync(globalFile)) {
    report.filesRead.push(globalFile);
    const mounts: Mount[] = [];
    for (const raw of fs.readFileSync(globalFile, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("dir=") || line.length <= 4) continue;
      const mount = parseMount(line.slice(4));
      if (mount) mounts.push(mount);
    }
    s.globalMounts = mounts;
    applied.add("globalMounts");
  }

  if (fs.existsSync(confPath)) {
    report.filesRead.push(confPath);
    const ini = readQtIni(confPath);
    const get = (k: string): QtValue | undefined => ini.get(k);

    const prompts = {
      workspace: "workspace",
      worktree: "worktree",
      portHint: "portHint",
      starter: "starter",
    } as const;
    for (const [field, key] of Object.entries(prompts) as [keyof typeof prompts, string][]) {
      const v = qtString(get(`prompts/${key}`));
      if (v !== undefined) {
        s.promptTemplates[field] = v;
        applied.add("promptTemplates");
      }
    }
    const completed = qtBool(get("setup/completed"));
    if (completed !== undefined) {
      s.setupCompleted = completed;
      applied.add("setupCompleted");
    }
    const dir = qtString(get("setup/defaultTargetDir"));
    if (dir) {
      s.defaultTargetDir = dir;
      applied.add("defaultTargetDir");
    }
    const identity = qtString(get("setup/sshIdentity"));
    if (identity) {
      s.sshIdentity = identity;
      applied.add("sshIdentity");
    }
    const scan = qtList(get("models/scan"))?.filter((m) => m !== "");
    const imageId = qtString(get("models/imageId"));
    const scanTime = Number(qtString(get("models/scanTime")));
    if (scan && scan.length > 0 && imageId && Number.isFinite(scanTime) && scanTime > 0) {
      s.modelCache = {
        imageId,
        scannedAt: new Date(scanTime * 1000).toISOString(),
        models: scan,
      };
      applied.add("modelCache");
    }
    const dirMap = (key: string) => {
      const list = qtList(get(key));
      if (list === undefined) return undefined;
      const out: Record<string, boolean> = {};
      for (const entry of list) {
        if (entry === "" || entry === "!") continue;
        if (entry.startsWith("!")) out[entry.slice(1)] = false;
        else out[entry] = true;
      }
      return out;
    };
    const ws = dirMap("newBox/workspaceDirs");
    if (ws) {
      s.newBoxDefaults.workspaceDirs = ws;
      applied.add("newBoxDefaults");
    }
    const wt = dirMap("newBox/worktreeDirs");
    if (wt) {
      s.newBoxDefaults.worktreeDirs = wt;
      applied.add("newBoxDefaults");
    }
  }
  report.settingsApplied = [...applied];
  return s;
}
