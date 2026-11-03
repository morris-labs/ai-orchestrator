// Multi-host for one server: its role, the hub side when the role is `hub`
// or `both`, the node side when the machine joined a hub, the link registry
// that route handlers use, and the machine list the API serves.
import os from "node:os";
import path from "node:path";
import {
  API_PREFIX,
  DEFAULT_GUI_PORT,
  DEFAULT_LINK_PORT,
  HUB_MACHINE_ID,
  LOCAL_MACHINE_ID,
  MachineListSchema,
  serverRoutes,
  type EnrollmentCode,
  type GlobalSettings,
  type GlobalSettingsPatch,
  type GuiClientList,
  type ImageStatus,
  type Machine,
  type MachineHealth,
  type NodeGrant,
  type NodeJoin,
  type NodeStatus,
} from "@aio/contracts";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../api/errors.js";
import { isThisMachine, parseProxyUrl } from "../api/machines.js";
import type { SqlDatabase } from "../api/core-interface.js";
import type { OpClient } from "../secrets/op.js";
import {
  CREDENTIAL_PATHS,
  CredentialStore,
  entryBytes,
  isCredentialKey,
  type CredentialEntry,
} from "./credentials.js";
import { jsonBody, jsonResponse, safely, type InternalHandler } from "./dispatch.js";
import { GuiListener } from "./gui.js";
import { HealthCache, fetchHealth, measureHealth } from "./health.js";
import { Hub, type LinkTiming } from "./hub.js";
import { detectLanAddress } from "./lan.js";
import type { LinkRegistry, NodeLink } from "./link.js";
import { HUB_LINK_ID, NodeAgent } from "./node.js";
import { LINK_CAPABILITIES, LINK_PROTOCOL, machinePlatform, type LinkHello } from "./protocol.js";
import { HubOpClient, RoleOpClient, opRelayHandlers } from "./secrets-relay.js";

export type MachineRole = Machine["role"];

/** The environment variable that overrides the stored role for one run. */
export const ROLE_ENV = "AIO_ROLE";

/** Parses a role name, or returns `undefined` for anything else. */
export function parseRole(value: string | undefined): MachineRole | undefined {
  return value === "hub" || value === "node" || value === "both" ? value : undefined;
}

/** The id of this machine in its own machine list. */
export const LOCAL_ID = "local";

/**
 * The routes a node may call on a hub whose role is `both`, so that it can
 * show the hub's boxes and projects in a machine tab. They only read: a node
 * controls only its own boxes. Terminals, directories, the event stream,
 * settings, secrets, accounts, machine enrollment and revocation, node routes,
 * and every route that starts, stops, creates, edits, or removes something
 * stay refused.
 */
export const HUB_BOX_ROUTES = [
  "boxes.list",
  "boxes.get",
  "projects.list",
] as const satisfies readonly (keyof typeof serverRoutes)[];

/**
 * The routes a node may call on another node through the hub, so that its
 * machine tabs and fleet views work: the `HUB_BOX_ROUTES`, and the read-only
 * run and finding routes. Settings, secrets, accounts, enrollment, node
 * routes, and every other route on the other node stay refused.
 */
export const NODE_RELAY_ROUTES = [
  ...HUB_BOX_ROUTES,
  "runs.list",
  "runs.get",
  "runs.groups",
  "runs.rounds",
  "findings.list",
  "findings.get",
] as const satisfies readonly (keyof typeof serverRoutes)[];

/**
 * A route's method and a pattern for its path. Each `:param` matches one
 * segment with no query, fragment, or leading dot, so that no dot segment
 * can turn an allowed path into another route.
 */
function routeMatcher(name: (typeof NODE_RELAY_ROUTES)[number]): { method: string; path: RegExp } {
  const route = serverRoutes[name];
  const source = route.path
    .split("/")
    .map((part) =>
      part.startsWith(":") ? "(?![.]|%2[eE])[^/?#]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return { method: route.method, path: new RegExp(`^${source}$`) };
}

const hubBoxMatchers = HUB_BOX_ROUTES.map(routeMatcher);
const nodeRelayMatchers = NODE_RELAY_ROUTES.map(routeMatcher);

/** True when a node may call `req` on a hub whose role is `both`. */
export function isHubBoxRoute(req: { method: string; path: string }): boolean {
  const method = req.method.toUpperCase();
  return hubBoxMatchers.some((m) => m.method === method && m.path.test(req.path));
}

/** True when a node may call `req` on another node through the hub. */
export function isNodeRelayRoute(req: { method: string; path: string }): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" && req.path === `${API_PREFIX}/health`) return true;
  return nodeRelayMatchers.some((m) => m.method === method && m.path.test(req.path));
}

/**
 * True when a URL parser leaves `path` as it is. A parser resolves dot
 * segments, turns backslashes into slashes, and drops tabs and newlines, so
 * any other path can reach a different route from the one it reads as.
 */
function isCanonicalPath(path: string): boolean {
  try {
    const url = new URL(path, "http://link.invalid");
    return url.pathname + url.search + url.hash === path;
  } catch {
    return false;
  }
}

/**
 * The API paths a node may call on its hub over the link: the machine list,
 * the health route, and the per-machine routes under `/api/v1/machines/ID/`
 * that relay the `NODE_RELAY_ROUTES` to other machines. When the hub runs boxes itself (`sharesBoxes`,
 * role `both`), also the `HUB_BOX_ROUTES`. Everything else on the hub stays
 * local.
 *
 * A per-machine route that names the hub itself (`local`, `hub`, or
 * whatever `isHub` accepts) is served by the hub, so the path after the
 * prefix must pass the same check. Without that, a node could reach every
 * hub route as `/api/v1/machines/local/proxy/<rest>`.
 */
export function defaultAllowNodeRequest(
  req: { method: string; path: string },
  isHub: (id: string) => boolean = (id) => id === LOCAL_MACHINE_ID || id === HUB_MACHINE_ID,
  sharesBoxes = false,
): boolean {
  if (!isCanonicalPath(req.path)) return false;
  const method = req.method.toUpperCase();
  if (method === "GET" && (req.path === "/api/v1/machines" || req.path === "/api/v1/health")) {
    return true;
  }
  if (sharesBoxes && isHubBoxRoute({ method, path: req.path })) {
    return true;
  }
  const target = parseProxyUrl(req.path);
  if (!target) return false;
  if (!isHub(target.machineId)) {
    return isNodeRelayRoute({ method, path: `${API_PREFIX}/${target.rest}` });
  }
  return defaultAllowNodeRequest(
    { method, path: `${API_PREFIX}/${target.rest}` },
    isHub,
    sharesBoxes,
  );
}

export interface MultiHostOptions {
  /** The home directory, for the host agent folders whose sign-ins are synced. */
  home: string;
  /** The absolute data directory. */
  dataDir: string;
  /** Milliseconds between the hub's checks of its sign-in files. Default 30 seconds; 0 turns the timer off. */
  credentialPollMs?: number;
  db: SqlDatabase;
  settings: () => GlobalSettings;
  patchSettings: (patch: GlobalSettingsPatch) => Promise<unknown>;
  /** The role from `--role` or `AIO_ROLE`, which wins over the stored one. */
  roleOverride?: MachineRole;
  version: string;
  /** The engine version this server expects in its image. */
  expectedEngineVersion?: string;
  /** The image's status, for this machine's health. Without it, the image reads as unknown. */
  imageStatus?: () => Promise<ImageStatus>;
  /** Milliseconds a machine list waits for a stale health to refresh. Default 3 seconds. */
  healthWaitMs?: number;
  token: string;
  /** This machine's API, once it exists. */
  api: () => FastifyInstance | null;
  /** The local 1Password client, which a hub uses and serves to its nodes. */
  op: OpClient;
  /**
   * The address the link listener binds, which wins over the `linkHost`
   * setting. Default: the primary LAN IPv4 address from `lanAddress`.
   */
  linkHost?: string;
  /** Finds the primary LAN IPv4 address; tests replace it. Default `detectLanAddress`. */
  lanAddress?: () => string | undefined;
  /** The link port, which wins over the setting; 0 picks a free one. */
  linkPort?: number;
  /** The GUI listener's port, which wins over the setting; 0 picks a free one. */
  guiPort?: number;
  /** The host name in hub URLs, which wins over the setting. Default: the bound address. */
  linkAddress?: string;
  /** The protocol version to speak; tests change it. Default `LINK_PROTOCOL`. */
  protocol?: number;
  timing?: LinkTiming & { backoffMinMs?: number; backoffMaxMs?: number };
  /** The host name. Default: `os.hostname()`. */
  hostname?: string;
  /** Whether a node may call a hub API path; default `defaultAllowNodeRequest`. */
  allowNodeRequest?: (req: { method: string; path: string }, machineId: string) => boolean;
  /** Extra link handlers, by `METHOD /path`, that this machine serves to the other end. */
  internal?: ReadonlyMap<string, InternalHandler>;
  log: (message: string) => void;
}

/** A machine name from a host name: the first label, with anything else replaced. */
export function nameFromHost(host: string): string {
  const label = host.split(".")[0] ?? "";
  const clean = label
    .replace(/[^A-Za-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63);
  return clean === "" ? "machine" : clean;
}

export class MultiHost {
  readonly hub: Hub;
  readonly node: NodeAgent;
  /** The listener for GUI apps on other PCs. */
  readonly gui: GuiListener;
  readonly links: LinkRegistry;
  /** The op client the secrets service uses: the hub's while this machine is a plain node. */
  readonly op: OpClient;
  readonly credentials: CredentialStore;
  /** The health of this machine and of the hub's linked nodes. */
  private readonly healthCache = new HealthCache();
  private lastHubList: Machine[] = [];
  private credentialTimer: NodeJS.Timeout | null = null;
  private credentialSync: Promise<void> = Promise.resolve();
  /** On a hub, the sign-in keys each linked node failed to receive, to send again. */
  private readonly undelivered = new Map<string, Set<string>>();

  constructor(private readonly opts: MultiHostOptions) {
    const hello = (): LinkHello => ({
      type: "hello",
      protocol: opts.protocol ?? LINK_PROTOCOL,
      capabilities: [...LINK_CAPABILITIES],
      serverVersion: opts.version,
      platform: process.platform,
      name: this.name(),
      role: this.role(),
    });
    this.credentials = new CredentialStore({
      home: opts.home,
      dataDir: opts.dataDir,
      log: opts.log,
    });
    const hubInternal = new Map<string, InternalHandler>([
      ...opRelayHandlers(
        () => opts.op,
        (machineId) => this.grantOf(machineId),
      ),
      ...this.hubCredentialHandlers(),
      ...(opts.internal ?? new Map()),
    ]);
    const nodeInternal = new Map<string, InternalHandler>([
      ...this.nodeCredentialHandlers(),
      ...(opts.internal ?? new Map()),
    ]);
    this.hub = new Hub({
      dir: path.join(opts.dataDir, "hub"),
      db: opts.db,
      isHub: () => this.role() !== "node",
      hello,
      port: () => opts.linkPort ?? opts.settings().linkPort ?? DEFAULT_LINK_PORT,
      bindHost: () =>
        opts.linkHost ?? opts.settings().linkHost ?? (opts.lanAddress ?? detectLanAddress)(),
      address: () => opts.linkAddress ?? opts.settings().linkAddress,
      token: opts.token,
      api: opts.api,
      internal: hubInternal,
      allowNodeRequest:
        opts.allowNodeRequest ??
        ((req) =>
          defaultAllowNodeRequest(
            req,
            (id) =>
              id === LOCAL_MACHINE_ID ||
              id === HUB_MACHINE_ID ||
              isThisMachine(id, { role: this.role(), machineId: this.machineId() }),
            this.role() === "both",
          )),
      timing: opts.timing,
      log: opts.log,
    });
    this.gui = new GuiListener({
      db: opts.db,
      isHub: () => this.role() !== "node",
      identity: () => this.hub.ensureIdentity(),
      port: () => opts.guiPort ?? opts.settings().guiPort ?? DEFAULT_GUI_PORT,
      bindHost: () =>
        opts.linkHost ?? opts.settings().linkHost ?? (opts.lanAddress ?? detectLanAddress)(),
      address: () => opts.linkAddress ?? opts.settings().linkAddress,
      token: opts.token,
      api: opts.api,
      log: opts.log,
    });
    this.node = new NodeAgent({
      dir: path.join(opts.dataDir, "link"),
      mayLink: () => this.role() !== "hub",
      hello,
      token: opts.token,
      api: opts.api,
      internal: nodeInternal,
      timing: opts.timing,
      log: opts.log,
      onChange: () => {
        if (!this.node.link) return;
        // Keep the hub's list at hand for while the hub is unreachable.
        void this.machines().catch(() => undefined);
        void this.pullCredentials();
      },
    });
    const hub = this.hub;
    const node = this.node;
    this.links = {
      get(machineId: string): NodeLink | undefined {
        if (machineId === HUB_LINK_ID) return node.link;
        return hub.get(machineId);
      },
      list(): string[] {
        return [...(node.link ? [HUB_LINK_ID] : []), ...hub.list()];
      },
    };
    this.op = new RoleOpClient(
      opts.op,
      new HubOpClient(() => node.link),
      () => this.role() === "node",
    );
  }

  /** The effective role: the override, else the setting, else `both`. */
  role(): MachineRole {
    return this.opts.roleOverride ?? this.opts.settings().role ?? "both";
  }

  /** This machine's name: the enrolled one, else the setting, else the host name. */
  name(): string {
    return (
      this.node.joined?.name ??
      this.opts.settings().machineName ??
      nameFromHost(this.opts.hostname ?? os.hostname())
    );
  }

  /** The id the hub gave this machine, or `undefined` before it joins one. */
  machineId(): string | undefined {
    return this.node.joined?.machineId;
  }

  /** True when `id` names a machine this hub enrolled and didn't revoke. */
  isKnown(id: string): boolean {
    const row = this.hub.registry.get(id);
    return row !== undefined && row.revokedAt === null;
  }

  async start(): Promise<void> {
    // A broken link to this machine's own hub must not stop the hub it serves.
    try {
      await this.node.start();
    } catch (err) {
      this.opts.log(`The node's link didn't start: ${(err as Error).message}`);
    }
    // On a joined node, a file with no copy record is the node's own sign-in.
    if (!this.node.joined) await this.credentials.prime();
    await this.hub.start();
    await this.gui.start();
    const pollMs = this.opts.credentialPollMs ?? 30_000;
    if (pollMs > 0) {
      this.credentialTimer = setInterval(() => void this.syncCredentials(), pollMs);
      this.credentialTimer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.credentialTimer) clearInterval(this.credentialTimer);
    await this.credentialSync;
    await this.gui.close();
    await this.node.close();
    await this.hub.close();
  }

  // -------------------------------------------------------------------------
  // Sign-in sync; see `credentials.ts`.

  /** What the hub's settings let an enrolled machine reach over the link. */
  private grantOf(machineId: string): NodeGrant | undefined {
    return this.opts.settings().nodeGrants?.[machineId];
  }

  private hubCredentialHandlers(): Map<string, InternalHandler> {
    return new Map<string, InternalHandler>([
      [
        `POST ${CREDENTIAL_PATHS.pull}`,
        safely(async (_req, caller) => {
          const allowed = this.grantOf(caller)?.signInCopies ?? [];
          const entries = await this.credentials.list();
          return jsonResponse(200, { entries: entries.filter((e) => allowed.includes(e.key)) });
        }),
      ],
    ]);
  }

  private nodeCredentialHandlers(): Map<string, InternalHandler> {
    return new Map<string, InternalHandler>([
      [
        `POST ${CREDENTIAL_PATHS.update}`,
        safely(async (req, caller) => {
          if (caller !== HUB_LINK_ID) {
            throw new ApiError("unauthorized", "Only the hub sends sign-ins.");
          }
          // A file that changed here stays: it can be the only valid copy.
          await this.credentials.write(parseEntry(jsonBody(req)), { keepLocalChange: true });
          return jsonResponse(200, { ok: true });
        }),
      ],
    ]);
  }

  /** Sends one sign-in file to every linked node whose grant lists it. */
  private async broadcastCredential(entry: CredentialEntry): Promise<void> {
    for (const id of this.hub.list()) await this.deliverCredential(id, entry);
  }

  /**
   * Sends one sign-in file to one node. A node without the capability or the
   * grant isn't due the file. A failure leaves the key for the next check.
   */
  private async deliverCredential(id: string, entry: CredentialEntry): Promise<void> {
    const pending = this.undelivered.get(id);
    if (
      !this.hub.helloOf(id)?.capabilities.includes("credentials.v1") ||
      !this.grantOf(id)?.signInCopies.includes(entry.key)
    ) {
      pending?.delete(entry.key);
      return;
    }
    const failed = (why: string) => {
      if (!pending?.has(entry.key)) this.opts.log(`Couldn't send ${entry.key} to ${id}: ${why}`);
      this.undelivered.set(id, (pending ?? new Set<string>()).add(entry.key));
    };
    try {
      const res = await this.hub.get(id)?.request({
        method: "POST",
        path: CREDENTIAL_PATHS.update,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(entry)),
      });
      if (res && res.status !== 200) failed(`status ${res.status}`);
      else pending?.delete(entry.key);
    } catch (err) {
      failed((err as Error).message);
    }
  }

  /** Sends again what a linked node failed to receive. A node that relinks pulls it instead. */
  private async retryUndelivered(): Promise<void> {
    for (const [id, keys] of this.undelivered) {
      if (!this.hub.get(id)) {
        this.undelivered.delete(id);
        continue;
      }
      for (const key of keys) {
        const entry = await this.credentials.entry(key);
        if (entry) await this.deliverCredential(id, entry);
        else keys.delete(key);
      }
    }
  }

  /** Copies the granted sign-in files from the hub, except files that changed here. */
  private pullCredentials(): Promise<void> {
    this.credentialSync = this.credentialSync.then(async () => {
      const link = this.node.link;
      if (!link || !link.can("credentials.v1")) return;
      try {
        const res = await link.request({
          method: "POST",
          path: CREDENTIAL_PATHS.pull,
          headers: {},
        });
        if (res.status !== 200) return;
        const { entries } = JSON.parse(res.body.toString()) as { entries: unknown[] };
        let wrote = 0;
        for (const raw of entries) {
          try {
            // A file that changed here stays: it can be the only valid copy.
            const entry = parseEntry(raw);
            if (await this.credentials.write(entry, { keepLocalChange: true })) wrote += 1;
          } catch (err) {
            this.opts.log(`Skipped a sign-in from the hub: ${(err as Error).message}`);
          }
        }
        if (wrote > 0) this.opts.log(`Copied ${wrote} sign-in file(s) from the hub.`);
      } catch (err) {
        this.opts.log(`Couldn't copy the sign-ins from the hub: ${(err as Error).message}`);
      }
    });
    return this.credentialSync;
  }

  /** On a hub, sends the sign-in files that changed to the nodes whose grant lists them. */
  syncCredentials(): Promise<void> {
    this.credentialSync = this.credentialSync.then(async () => {
      if (this.node.joined || this.role() === "node" || this.hub.list().length === 0) return;
      await this.retryUndelivered();
      for (const entry of await this.credentials.changes()) {
        await this.broadcastCredential(entry);
        await this.credentials.markSynced(entry.key, entry.sha256);
      }
    });
    return this.credentialSync;
  }

  private localMachine(): Machine {
    return {
      id: LOCAL_ID,
      name: this.name(),
      role: this.role(),
      status: "online",
      isLocal: true,
      serverVersion: this.opts.version,
      protocol: this.opts.protocol ?? LINK_PROTOCOL,
      capabilities: [...LINK_CAPABILITIES],
      lastSeen: new Date().toISOString(),
      platform: machinePlatform(process.platform),
    };
  }

  /**
   * The machine list: this machine first, as `local`. A hub adds its
   * enrolled machines. A node that joined a hub adds the hub's list, with
   * the hub as `hub` and its own entry left out; while the hub is
   * unreachable, it shows the last list it got, every machine offline.
   */
  async machines(): Promise<Machine[]> {
    const local = this.localMachine();
    const out: Machine[] = [local];
    if (this.role() !== "node") out.push(...this.hub.machines());
    await this.addHealth(out);
    const joined = this.node.joined;
    if (!joined || this.role() === "hub") return out;
    const link = this.node.link;
    if (link) {
      try {
        const res = await link.request({
          method: "GET",
          path: "/api/v1/machines",
          headers: { accept: "application/json" },
        });
        if (res.status === 200) {
          const list = MachineListSchema.parse(JSON.parse(res.body.toString())).machines;
          this.lastHubList = list
            .filter((m) => m.id !== joined.machineId)
            .map((m) => (m.isLocal ? { ...m, id: HUB_LINK_ID, isLocal: false } : m));
          return [...out, ...this.lastHubList];
        }
      } catch {
        // Fall through to the last list.
      }
    }
    const cached = this.lastHubList.some((m) => m.id === HUB_LINK_ID)
      ? this.lastHubList
      : [
          {
            id: HUB_LINK_ID,
            name: new URL(joined.hubUrl).hostname,
            role: "hub" as const,
            status: "offline" as const,
            isLocal: false,
            serverVersion: null,
            protocol: null,
            capabilities: [],
            lastSeen: null,
            platform: null,
          },
          ...this.lastHubList,
        ];
    return [
      ...out,
      ...cached.map((m) => ({
        ...m,
        status: m.status === "revoked" ? m.status : ("offline" as const),
      })),
    ];
  }

  /** Measures this machine's health now. */
  health(): Promise<MachineHealth> {
    return measureHealth({
      dataDir: this.opts.dataDir,
      expectedEngineVersion: this.opts.expectedEngineVersion ?? this.opts.version,
      imageStatus: this.opts.imageStatus,
    });
  }

  /**
   * Sets `health` on this machine's entry and on each enrolled machine's. A
   * linked node with `health.v1` is asked when its cached value is stale;
   * any other machine shows its last known health, or `null`.
   */
  private async addHealth(list: Machine[]): Promise<void> {
    const wait = this.opts.healthWaitMs;
    await Promise.all(
      list.map(async (m) => {
        if (m.isLocal) {
          m.health = await this.healthCache.get(LOCAL_ID, () => this.health(), wait);
          return;
        }
        if (m.status === "revoked") {
          this.healthCache.delete(m.id);
          m.health = null;
          return;
        }
        const link = this.hub.get(m.id);
        m.health =
          link && this.hub.helloOf(m.id)?.capabilities.includes("health.v1")
            ? await this.healthCache.get(m.id, () => fetchHealth(link), wait)
            : this.healthCache.peek(m.id);
      }),
    );
  }

  enroll(): Promise<EnrollmentCode> {
    return this.hub.issueCode();
  }

  revoke(id: string): Promise<void> {
    if (id === LOCAL_ID) throw new ApiError("validation", "A machine can't revoke itself.");
    return this.hub.revoke(id);
  }

  guiClients(): GuiClientList {
    return this.gui.list();
  }

  enrollGui(): Promise<EnrollmentCode> {
    return this.gui.issueCode();
  }

  revokeGui(id: string): Promise<void> {
    return this.gui.revoke(id);
  }

  status(): NodeStatus {
    const joined = this.node.joined;
    const { link, error } = this.node.status();
    return {
      role: this.role(),
      name: this.name(),
      machineId: joined?.machineId ?? null,
      hubUrl: joined?.hubUrl ?? null,
      link: this.role() === "hub" ? "none" : link,
      error: this.role() === "hub" ? null : error,
      linkPort: this.hub.port,
      ...(this.opts.roleOverride ? { roleOverride: this.opts.roleOverride } : {}),
    };
  }

  /**
   * Joins a hub. A machine whose role is `hub` can't unless the caller asks
   * to leave that role, nor can a machine that has enrolled machines of its
   * own. A `both` or `hub` machine becomes a `node`, so it stops acting as a
   * hub and asks the new hub for secrets. A `hub` machine keeps its role until
   * the join succeeds, so that its nodes never reach its boxes on the way. A
   * machine that has joined a hub stays with it unless `NodeAgent.join` allows
   * the change.
   */
  async join(input: NodeJoin): Promise<NodeStatus> {
    const role = this.role();
    if (role === "hub" && this.opts.roleOverride === "hub") {
      throw new ApiError(
        "invalid_state",
        `This server runs with --role hub or ${ROLE_ENV}=hub. Start it without that override, or with node, to join a hub.`,
      );
    }
    if (role === "hub" && !input.leaveHubRole) {
      throw new ApiError(
        "invalid_state",
        "This machine's role is hub, so it can't join another hub.",
      );
    }
    if (role !== "node" && this.hub.registry.liveCount() > 0) {
      throw new ApiError(
        "invalid_state",
        "This machine is a hub with enrolled machines. Revoke them first, or set its role to node.",
      );
    }
    if (role === "both" && this.opts.roleOverride === "both") {
      throw new ApiError(
        "invalid_state",
        `This server runs with --role both or ${ROLE_ENV}=both. Start it without that override, or with node, to join a hub.`,
      );
    }
    // What this machine has now is its own, so the new hub's copies don't replace it.
    const hashes = await this.credentials.hashes();
    await this.credentials.forget();
    try {
      await this.node.join({
        hubUrl: input.hubUrl,
        code: input.code,
        name: input.name ?? this.name(),
        replaceHub: input.replaceHub,
      });
    } catch (error) {
      // The machine stays with its old hub, or none, so its copy records still count.
      await this.credentials.restoreHashes(hashes);
      throw error;
    }
    if (this.opts.settings().role !== "node" && this.opts.roleOverride === undefined) {
      await this.opts.patchSettings({ role: "node" });
      await this.hub.reconcile();
      // The agent couldn't link while the role was hub.
      if (role === "hub") this.node.restart();
    }
    return this.status();
  }
}

/** Checks a synced file from the other end. */
function parseEntry(raw: unknown): CredentialEntry {
  const { key, content, sha256 } = (raw ?? {}) as Record<string, unknown>;
  if (typeof key !== "string" || !isCredentialKey(key)) {
    throw new ApiError("validation", "The sign-in entry names no file the sync allows.");
  }
  const entry = { key, content, sha256 } as CredentialEntry;
  if (typeof content !== "string" || typeof sha256 !== "string" || !entryBytes(entry)) {
    throw new ApiError("validation", `The content for ${key} isn't a valid sign-in file.`);
  }
  return entry;
}
