// The secret relay. Only the hub holds the 1Password service account token,
// so a plain node resolves its secret references by asking the hub over the
// link. The node keeps its own references and its secrets service, whose
// in-memory cache keeps each value for the same time as on a hub; only the
// `op` calls cross the link. With the hub down, a node can't read a value it
// hasn't cached.
//
// No value is logged. An error that crosses the link carries the hub's
// message, which `OpCli` already keeps free of values.
import type { OpStatus } from "@aio/contracts";
import { ApiError, isApiErrorCode } from "../api/errors.js";
import type { OpClient, OpItemInfo } from "../secrets/op.js";
import { jsonBody, jsonResponse, safely, type InternalHandler } from "./dispatch.js";
import type { NodeLink } from "./link.js";

/** The link paths of the relay, on the hub. */
export const OP_PATHS = {
  status: "/link/v1/op/status",
  read: "/link/v1/op/read",
  listItems: "/link/v1/op/list-items",
} as const;

/** The hub's handlers for the relay, served to its nodes. */
export function opRelayHandlers(op: () => OpClient): Map<string, InternalHandler> {
  return new Map<string, InternalHandler>([
    [`POST ${OP_PATHS.status}`, safely(async () => jsonResponse(200, await op().status()))],
    [
      `POST ${OP_PATHS.read}`,
      safely(async (req) => {
        const { ref } = jsonBody(req) as { ref?: unknown };
        if (typeof ref !== "string" || !ref.startsWith("op://")) {
          throw new ApiError("validation", "The relay reads only op:// references.");
        }
        return jsonResponse(200, { value: await op().read(ref) });
      }),
    ],
    [
      `POST ${OP_PATHS.listItems}`,
      safely(async (req) => {
        const { vault } = jsonBody(req) as { vault?: unknown };
        if (typeof vault !== "string" || vault === "") {
          throw new ApiError("validation", "Name a vault.");
        }
        return jsonResponse(200, { items: await op().listItems(vault) });
      }),
    ],
  ]);
}

/** The status a node reports while it can't ask its hub. */
const UNREACHABLE: OpStatus = { installed: false, version: null, signedIn: false, mode: "none" };

/**
 * An `OpClient` that asks the hub. `link` returns the link to the hub, or
 * `undefined` while it's down.
 */
export class HubOpClient implements OpClient {
  constructor(private readonly link: () => NodeLink | undefined) {}

  async status(): Promise<OpStatus> {
    try {
      return (await this.call(OP_PATHS.status, {})) as OpStatus;
    } catch {
      return UNREACHABLE;
    }
  }

  async read(ref: string): Promise<string> {
    const { value } = (await this.call(OP_PATHS.read, { ref })) as { value: string };
    if (typeof value !== "string")
      throw new ApiError("secrets_unavailable", "The hub's answer has no value.");
    return value;
  }

  async listItems(vault: string): Promise<OpItemInfo[]> {
    return ((await this.call(OP_PATHS.listItems, { vault })) as { items: OpItemInfo[] }).items;
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    const link = this.link();
    if (!link) {
      throw new ApiError(
        "secrets_unavailable",
        "This node reads secrets through its hub, and the hub is unreachable. Values read in the last few minutes still resolve from the cache.",
      );
    }
    let res;
    try {
      res = await link.request({
        method: "POST",
        path,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(body)),
      });
    } catch (err) {
      throw new ApiError(
        "secrets_unavailable",
        `This node couldn't ask its hub for a secret: ${(err as Error).message}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(res.body.toString());
    } catch {
      throw new ApiError("secrets_unavailable", "The hub's answer isn't JSON.");
    }
    if (res.status !== 200) {
      const error = (json as { error?: { code?: unknown; message?: unknown } }).error;
      const code = isApiErrorCode(error?.code) ? error.code : "secrets_unavailable";
      throw new ApiError(code, `The hub: ${String(error?.message ?? `status ${res.status}`)}`);
    }
    return json;
  }
}

/**
 * An `OpClient` that asks the hub while this machine's role is `node`, and
 * uses the local `op` otherwise. The role can change at run time, when the
 * machine joins a hub.
 */
export class RoleOpClient implements OpClient {
  constructor(
    private readonly local: OpClient,
    private readonly relay: OpClient,
    private readonly isNode: () => boolean,
  ) {}

  private pick(): OpClient {
    return this.isNode() ? this.relay : this.local;
  }

  status(): Promise<OpStatus> {
    return this.pick().status();
  }

  read(ref: string): Promise<string> {
    return this.pick().read(ref);
  }

  listItems(vault: string): Promise<OpItemInfo[]> {
    return this.pick().listItems(vault);
  }
}
