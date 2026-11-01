// A machine's health for the Machines page: the engine in its image and the
// free space where it keeps its data. Each machine measures its own; the
// hub asks each linked node for its health over the link and caches the
// answers, so a list request costs at most one round trip per node every
// `HEALTH_TTL_MS`.
import { statfs } from "node:fs/promises";
import { MachineHealthSchema, type ImageStatus, type MachineHealth } from "@aio/contracts";
import type { NodeLink } from "./link.js";

/** How long a measured health stays fresh: 30 seconds. */
export const HEALTH_TTL_MS = 30_000;
/** How long a machine list waits for a stale health to refresh: 3 seconds. */
export const HEALTH_WAIT_MS = 3_000;
/** The API path a hub calls on a node for its health. */
export const NODE_HEALTH_PATH = "/api/v1/node/health";

/** Measures this machine's health. A part that fails reads as unknown. */
export async function measureHealth(opts: {
  dataDir: string;
  expectedEngineVersion: string;
  imageStatus?: () => Promise<ImageStatus>;
  now?: () => Date;
}): Promise<MachineHealth> {
  let engineVersion: string | null = null;
  let expectedEngineVersion = opts.expectedEngineVersion;
  let image: MachineHealth["image"] = "unknown";
  if (opts.imageStatus) {
    try {
      const status = await opts.imageStatus();
      engineVersion = status.engineVersion;
      expectedEngineVersion = status.expectedEngineVersion;
      image = !status.exists ? "missing" : status.engineMatches ? "ready" : "mismatch";
    } catch {
      image = "unknown";
    }
  }
  let diskFreeBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const stats = await statfs(opts.dataDir);
    diskFreeBytes = stats.bavail * stats.bsize;
    diskTotalBytes = stats.blocks * stats.bsize;
  } catch {
    // The data directory might not exist yet.
  }
  return {
    engineVersion,
    expectedEngineVersion,
    image,
    diskFreeBytes,
    diskTotalBytes,
    checkedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
}

/** Asks a linked node for its health; `null` when it doesn't answer with one. */
export async function fetchHealth(link: NodeLink): Promise<MachineHealth | null> {
  const res = await link.request({
    method: "GET",
    path: NODE_HEALTH_PATH,
    headers: { accept: "application/json" },
  });
  if (res.status !== 200) return null;
  const parsed = MachineHealthSchema.safeParse(JSON.parse(res.body.toString()));
  return parsed.success ? parsed.data : null;
}

/**
 * The last health of each machine. A stale entry refreshes on the next
 * read, which waits a bounded time for it; one refresh runs per machine at
 * a time. A failed refresh keeps the last value.
 */
export class HealthCache {
  private readonly values = new Map<string, { at: number; value: MachineHealth | null }>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly ttlMs = HEALTH_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The last value for `id`, without refreshing it. */
  peek(id: string): MachineHealth | null {
    return this.values.get(id)?.value ?? null;
  }

  /** The value for `id`, refreshed with `fetch` first when stale, waiting at most `waitMs`. */
  async get(
    id: string,
    fetch: () => Promise<MachineHealth | null>,
    waitMs = HEALTH_WAIT_MS,
  ): Promise<MachineHealth | null> {
    const entry = this.values.get(id);
    if (entry && this.now() - entry.at < this.ttlMs) return entry.value;
    let pending = this.pending.get(id);
    if (!pending) {
      const keep = (value: MachineHealth | null) => {
        this.values.set(id, { at: this.now(), value: value ?? this.peek(id) });
      };
      pending = fetch()
        .then(keep, () => keep(null))
        .finally(() => this.pending.delete(id));
      this.pending.set(id, pending);
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    return this.peek(id);
  }

  /** Forgets a machine, such as one that was revoked. */
  delete(id: string): void {
    this.values.delete(id);
  }
}
