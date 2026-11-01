// Multi-host for one server: its role, the hub side when the role is `hub`
// or `both`, the node side when the machine joined a hub, the link registry
// that route handlers use, and the machine list the API serves.
import os from "node:os";
import path from "node:path";
import {
  API_PREFIX,
  DEFAULT_LINK_PORT,
  HUB_MACHINE_ID,
  LOCAL_MACHINE_ID,
  MachineListSchema,
  serverRoutes,
  type EnrollmentCode,
  type GlobalSettings,
  type GlobalSettingsPatch,
  type ImageStatus,
  type Machine,
  type MachineHealth,
  type NodeJoin,
  type NodeStatus,
} from "@aio/contracts";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../api/errors.js";
import { isThisMachine, parseProxyUrl } from "../api/machines.js";
import type { SqlDatabase } from "../api/core-interface.js";
import type { OpClient } from "../secrets/op.js";
import { CREDENTIAL_PATHS, CredentialStore, isCredentialKey } from "./credentials.js";
import { jsonBody, jsonResponse, safely, type InternalHandler } from "./dispatch.js";
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
 * show the hub's boxes in a machine tab and operate them: list, get, start,
 * stop, and restart boxes, their terminals and the event stream, and the
 * project list and directory browser that the tab uses. Settings, secrets,
 * accounts, machine enrollment and revocation, node routes, and every
 * route that creates, edits, or removes something stay refused.
 */
export const HUB_BOX_ROUTES = [
  "boxes.list",
  "boxes.get",
  "boxes.start",
  "boxes.stop",
  "boxes.restart",
  "events.stream",
  "terminals.open",
  "projects.list",
  "fs.dirs",
] as const satisfies readonly (keyof typeof serverRoutes)[];

/**
 * A route's method and a pattern for its path. Each `:param` matches one
 * segment with no query, fragment, or leading dot, so that no dot segment
 * can turn an allowed path into another route.
 */
function routeMatcher(name: (typeof HUB_BOX_ROUTES)[number]): { method: string; path: RegExp } {
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

/** True when a node may call `req` on a hub whose role is `both`. */
export function isHubBoxRoute(req: { method: string; path: string }): boolean {
  const method = req.method.toUpperCase();
  return hubBoxMatchers.some((m) => m.method === method && m.path.test(req.path));
}

/**
 * The API paths a node may call on its hub over the link: the machine list,
 * the health route, and the per-machine routes under `/api/v1/machines/ID/`
 * that relay to other machines. When the hub runs boxes itself (`sharesBoxes`,
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
  caller?: string,
  isHub: (id: string) => boolean = (id) => id === LOCAL_MACHINE_ID || id === HUB_MACHINE_ID,
  sharesBoxes = false,
): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" && (req.path === "/api/v1/machines" || req.path === "/api/v1/health")) {
    return true;
  }
  if (sharesBoxes && isHubBoxRoute({ method, path: req.path })) return true;
  const target = parseProxyUrl(req.path);
  if (!target) return false;
  if (!isHub(target.machineId)) return true;
  return defaultAllowNodeRequest(
    { method, path: `${API_PREFIX}/${target.rest}` },
    caller,
    isHub,
    sharesBoxes,
  );
}

export interface MultiHostOptions {
  /** The home directory, for the host agent folders whose sign-ins are synced. */
  home: string;
  /** The absolute data directory. */
  dataDir: string;
  /** Milliseconds between checks of the synced sign-in files. Default 30 seconds; 0 turns the timer off. */
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
  readonly links: LinkRegistry;
  /** The op client the secrets service uses: the hub's while this machine is a plain node. */
  readonly op: OpClient;
  readonly credentials: CredentialStore;
  /** The health of this machine and of the hub's linked nodes. */
  private readonly healthCache = new HealthCache();
  private lastHubList: Machine[] = [];
  private credentialTimer: NodeJS.Timeout | null = null;
  private credentialSync: Promise<void> = Promise.resolve();

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
    this.credentials = new CredentialStore({ home: opts.home, dataDir: opts.dataDir });
    const hubInternal = new Map<string, InternalHandler>([
      ...opRelayHandlers(() => opts.op),
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
        ((req, caller) =>
          defaultAllowNodeRequest(
            req,
            caller,
            (id) =>
              id === LOCAL_MACHINE_ID ||
              id === HUB_MACHINE_ID ||
              isThisMachine(id, { role: this.role(), machineId: this.machineId() }),
            this.role() === "both",
          )),
      timing: opts.timing,
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
        // Send what changed here while the link was down, then take the hub's.
        void this.syncCredentials().then(() => this.pullCredentials());
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
    await this.credentials.prime();
    await this.node.start();
    await this.hub.start();
    const pollMs = this.opts.credentialPollMs ?? 30_000;
    if (pollMs > 0) {
      this.credentialTimer = setInterval(() => void this.syncCredentials(), pollMs);
      this.credentialTimer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.credentialTimer) clearInterval(this.credentialTimer);
    await this.credentialSync;
    await this.node.close();
    await this.hub.close();
  }

  // -------------------------------------------------------------------------
  // Sign-in sync; see `credentials.ts`.

  private hubCredentialHandlers(): Map<string, InternalHandler> {
    return new Map<string, InternalHandler>([
      [
        `POST ${CREDENTIAL_PATHS.pull}`,
        safely(async () => jsonResponse(200, { entries: await this.credentials.list() })),
      ],
      [
        `POST ${CREDENTIAL_PATHS.push}`,
        safely(async (req, caller) => {
          const entry = parseEntry(jsonBody(req));
          if (await this.credentials.write(entry)) {
            this.opts.log(`Took a refreshed sign-in, ${entry.key}, from ${caller}.`);
          }
          await this.broadcastCredential(entry, caller);
          return jsonResponse(200, { ok: true });
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
          await this.credentials.write(parseEntry(jsonBody(req)));
          return jsonResponse(200, { ok: true });
        }),
      ],
    ]);
  }

  /** Sends one sign-in file to every linked node that syncs, except `except`. */
  private async broadcastCredential(
    entry: { key: string; content: string },
    except?: string,
  ): Promise<void> {
    for (const id of this.hub.list()) {
      if (id === except || !this.hub.helloOf(id)?.capabilities.includes("credentials.v1")) continue;
      try {
        await this.hub.get(id)?.request({
          method: "POST",
          path: CREDENTIAL_PATHS.update,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ key: entry.key, content: entry.content })),
        });
      } catch (err) {
        this.opts.log(`Couldn't send ${entry.key} to ${id}: ${(err as Error).message}`);
      }
    }
  }

  /** Copies every sign-in file from the hub, which is the source of truth. */
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
            if (await this.credentials.write(parseEntry(raw))) wrote += 1;
          } catch {
            // A key this machine doesn't allow; skip it.
          }
        }
        if (wrote > 0) this.opts.log(`Copied ${wrote} sign-in file(s) from the hub.`);
      } catch (err) {
        this.opts.log(`Couldn't copy the sign-ins from the hub: ${(err as Error).message}`);
      }
    });
    return this.credentialSync;
  }

  /**
   * Checks the sign-in files once: a node sends what changed to the hub, and
   * a hub sends what changed to its nodes.
   */
  syncCredentials(): Promise<void> {
    this.credentialSync = this.credentialSync.then(async () => {
      // A machine that joined a hub syncs with it; a hub syncs with its nodes.
      const link = this.node.joined ? this.node.link : undefined;
      if (this.node.joined && !link) return;
      if (!link && (this.role() === "node" || this.hub.list().length === 0)) return;
      const changes = await this.credentials.changes();
      for (const entry of changes) {
        if (!link) {
          await this.broadcastCredential(entry);
          continue;
        }
        if (!link?.can("credentials.v1")) continue;
        try {
          await link.request({
            method: "POST",
            path: CREDENTIAL_PATHS.push,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ key: entry.key, content: entry.content })),
          });
          this.opts.log(`Sent a refreshed sign-in, ${entry.key}, to the hub.`);
        } catch (err) {
          this.opts.log(`Couldn't send ${entry.key} to the hub: ${(err as Error).message}`);
        }
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
    };
  }

  /**
   * Joins a hub. A machine whose role is `hub` can't, nor can a `both`
   * machine that has enrolled machines of its own. A `both` machine becomes
   * a `node`, so it stops acting as a hub and asks the new hub for secrets.
   */
  async join(input: NodeJoin): Promise<NodeStatus> {
    const role = this.role();
    if (role === "hub") {
      throw new ApiError(
        "invalid_state",
        "This machine's role is hub, so it can't join another hub.",
      );
    }
    if (role === "both" && this.hub.registry.liveCount() > 0) {
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
    await this.node.join({
      hubUrl: input.hubUrl,
      code: input.code,
      name: input.name ?? this.name(),
    });
    if (this.opts.settings().role !== "node" && this.opts.roleOverride === undefined) {
      await this.opts.patchSettings({ role: "node" });
      await this.hub.reconcile();
    }
    return this.status();
  }
}

/** Checks a synced file from the other end. */
function parseEntry(raw: unknown): { key: string; content: string } {
  const { key, content } = (raw ?? {}) as { key?: unknown; content?: unknown };
  if (typeof key !== "string" || !isCredentialKey(key) || typeof content !== "string") {
    throw new ApiError("validation", "The sign-in entry names no file the sync allows.");
  }
  return { key, content };
}
