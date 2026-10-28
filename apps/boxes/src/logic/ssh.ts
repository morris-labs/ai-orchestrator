// SSH remote form helpers: the `user@host[:port]` target and the forward
// rows, which 3.3.5 stored as `L|R:bindAddr:bindPort:destHost:destPort`.
import type { SshForward } from "@agentbox/contracts";

/** True for `host`, `user@host`, and either with `:port`. */
export function validTarget(target: string): boolean {
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(target.trim());
}

export function formatForward(f: SshForward): string {
  return `${f.direction}:${f.bindAddress}:${f.bindPort}:${f.destHost}:${f.destPort}`;
}

/** Parses a 3.3.5 forward spec, or returns `null`. */
export function parseForward(spec: string): SshForward | null {
  const m = /^([LR]):([^:]+):(\d+):([^:]+):(\d+)$/.exec(spec.trim());
  if (!m) return null;
  const bindPort = Number(m[3]);
  const destPort = Number(m[5]);
  if (bindPort < 1 || bindPort > 65535 || destPort < 1 || destPort > 65535) return null;
  return {
    direction: m[1] as "L" | "R",
    bindAddress: m[2] as string,
    bindPort,
    destHost: m[4] as string,
    destPort,
  };
}

export interface ForwardRow {
  direction: "L" | "R";
  bindAddress: string;
  bindPort: string;
  destHost: string;
  destPort: string;
}

/** Turns editor rows into forwards, or lists the rows that are wrong. */
export function rowsToForwards(rows: readonly ForwardRow[]): {
  forwards: SshForward[];
  problems: string[];
} {
  const forwards: SshForward[] = [];
  const problems: string[] = [];
  rows.forEach((r, i) => {
    const f = parseForward(
      `${r.direction}:${r.bindAddress.trim() || "localhost"}:${r.bindPort.trim()}:${r.destHost.trim()}:${r.destPort.trim()}`,
    );
    if (f) forwards.push(f);
    else
      problems.push(
        `Forward ${i + 1} needs a bind port, a destination host, and a destination port.`,
      );
  });
  return { forwards, problems };
}
