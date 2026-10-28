// Checks for a newer Agent Box release and a Claude Code newer than the
// image's. A network failure gives `null` versions, never an error.
import type { Updates } from "@agentbox/contracts";
import type { Core } from "../api/core-interface.js";

export interface UpdateCheckerOptions {
  fetch?: typeof fetch;
  currentVersion: string;
  image: Pick<Core["image"], "status">;
  repo?: string;
  now?: () => Date;
  ttlMs?: number;
}

/**
 * Compares two versions numerically, part by part; a pre-release such as
 * `4.0.0-dev` sorts before `4.0.0`. Returns a negative number, 0, or a
 * positive number.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { parts: main.split(".").map((p) => Number.parseInt(p, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i += 1) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export class UpdateChecker {
  private cached: { at: number; value: Updates } | null = null;

  constructor(private readonly opts: UpdateCheckerOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private async json(url: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await (this.opts.fetch ?? fetch)(url, {
        headers: { accept: "application/json", "user-agent": "agentbox-server" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async check(force: boolean): Promise<Updates> {
    const now = this.now();
    const ttl = this.opts.ttlMs ?? 24 * 60 * 60 * 1000;
    if (!force && this.cached && now.getTime() - this.cached.at < ttl) return this.cached.value;

    const repo = this.opts.repo ?? "morris-labs/Claude-Box";
    const [release, npm, image] = await Promise.all([
      this.json(`https://api.github.com/repos/${repo}/releases/latest`),
      this.json("https://registry.npmjs.org/@anthropic-ai/claude-code/latest"),
      this.opts.image.status().catch(() => null),
    ]);
    const tag = typeof release?.tag_name === "string" ? release.tag_name.replace(/^v/, "") : null;
    let releaseUrl: string | null = null;
    if (typeof release?.html_url === "string") {
      try {
        releaseUrl = new URL(release.html_url).toString();
      } catch {
        releaseUrl = null;
      }
    }
    const latestClaude = typeof npm?.version === "string" ? npm.version : null;
    const imageClaude = image?.exists ? image.cliVersions.claude : null;
    const value: Updates = {
      checkedAt: now.toISOString(),
      app: {
        current: this.opts.currentVersion,
        latest: tag,
        updateAvailable: tag !== null && compareVersions(tag, this.opts.currentVersion) > 0,
        releaseUrl,
      },
      claudeCode: {
        image: imageClaude,
        latest: latestClaude,
        stale:
          imageClaude !== null &&
          latestClaude !== null &&
          compareVersions(latestClaude, imageClaude) > 0,
      },
    };
    this.cached = { at: now.getTime(), value };
    return value;
  }
}
