// Multi-host for one server: its role, the hub side when the role is `hub`
// or `both`, the node side when the machine joined a hub, the link registry
// that route handlers use, and the machine list the API serves.
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LINK_PORT,
  MachineListSchema,
  type EnrollmentCode,
  type GlobalSettings,
  type GlobalSettingsPatch,
  type Machine,
  type NodeJoin,
  type NodeStatus,
} from "@aio/contracts";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../api/errors.js";
import type { SqlDatabase } from "../api/core-interface.js";
import type { OpClient } from "../secrets/op.js";
import type { InternalHandler } from "./dispatch.js";
import { Hub, type LinkTiming } from "./hub.js";
import type { LinkRegistry, NodeLink } from "./link.js";
import { HUB_LINK_ID, NodeAgent } from "./node.js";
import {
  LINK_CAPABILITIES,
  LINK_PROTOCOL,
  machinePlatform,
  type LinkHello,
} from "./protocol.js";
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
 * The API paths a node may call on its hub over the link: the machine list,
 * the health route, and the per-machine routes under `/api/v1/machines/ID/`
 * that relay to other machines. Everything else on the hub stays local.
 */
export function defaultAllowNodeRequest(req: { method: string; path: string }): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" && (req.path === "/api/v1/machines" || req.path === "/api/v1/health")) {
    return true;
  }
  return /^\/api\/v1\/machines\/[^/]+\/proxy(\/|$)/.test(req.path);
}

export interface MultiHostOptions {
  /** The absolute data directory. */
  dataDir: string;
  db: SqlDatabase;
  settings: () => GlobalSettings;
  patchSettings: (patch: GlobalSettingsPatch) => Promise<unknown>;
  /** The role from `--role` or `AIO_ROLE`, which wins over the stored one. */
  roleOverride?: MachineRole;
  version: string;
  token: string;
  /** This machine's API, once it exists. */
  api: () => FastifyInstance | null;
  /** The local 1Password client, which a hub uses and serves to its nodes. */
  op: OpClient;
  /** The address the link listener binds. Default: every interface. */
  linkHost?: string;
  /** The link port, which wins over the setting; 0 picks a free one. */
  linkPort?: number;
  /** The host name in hub URLs, which wins over the setting. */
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
  const clean = label.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 63);
  return clean === "" ? "machine" : clean;
}

export class MultiHost {
  readonly hub: Hub;
  readonly node: NodeAgent;
  readonly links: LinkRegistry;
  /** The op client the secrets service uses: the hub's while this machine is a plain node. */
  readonly op: OpClient;
  private lastHubList: Machine[] = [];

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
    const hubInternal = new Map<string, InternalHandler>([
      ...opRelayHandlers(() => opts.op),
      ...(opts.internal ?? new Map()),
    ]);
    this.hub = new Hub({
      dir: path.join(opts.dataDir, "hub"),
      db: opts.db,
      isHub: () => this.role() !== "node",
      hello,
      port: () => opts.linkPort ?? opts.settings().linkPort ?? DEFAULT_LINK_PORT,
      bindHost: opts.linkHost,
      address: () =>
        opts.linkAddress ?? opts.settings().linkAddress ?? opts.hostname ?? os.hostname(),
      token: opts.token,
      api: opts.api,
      internal: hubInternal,
      allowNodeRequest: opts.allowNodeRequest ?? defaultAllowNodeRequest,
      timing: opts.timing,
      log: opts.log,
    });
    this.node = new NodeAgent({
      dir: path.join(opts.dataDir, "link"),
      mayLink: () => this.role() !== "hub",
      hello,
      token: opts.token,
      api: opts.api,
      internal: opts.internal ?? new Map(),
      timing: opts.timing,
      log: opts.log,
      // Keep the hub's list at hand for while the hub is unreachable.
      onChange: () => {
        if (this.node.link) void this.machines().catch(() => undefined);
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
    await this.node.start();
    await this.hub.start();
  }

  async close(): Promise<void> {
    await this.node.close();
    await this.hub.close();
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
      throw new ApiError("invalid_state", "This machine's role is hub, so it can't join another hub.");
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
    await this.node.join({ hubUrl: input.hubUrl, code: input.code, name: input.name ?? this.name() });
    if (this.opts.settings().role !== "node" && this.opts.roleOverride === undefined) {
      await this.opts.patchSettings({ role: "node" });
      await this.hub.reconcile();
    }
    return this.status();
  }
}
