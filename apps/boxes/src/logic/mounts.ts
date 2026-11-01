// Parsing and checking of the mount and TCP map editors.
import {
  defaultContainerPath,
  guessHostOs,
  hostPathProblem,
  type Mount,
  type TcpMap,
} from "@aio/contracts";

/**
 * One `HOST[:CONTAINER]` line; the container path defaults to the host
 * path's container path: the host path itself, or `/mnt/host/c/...` for a
 * Windows path such as `C:\data`, whose drive colon belongs to the host part.
 */
export function parseMountLine(line: string): Mount | null {
  const t = line.trim();
  if (t === "") return null;
  const i = t.indexOf(":", guessHostOs(t) === "win32" && /^[A-Za-z]:/.test(t) ? 2 : 0);
  if (i < 0) return { host: t, container: defaultContainerPath(t) };
  const host = t.slice(0, i).trim();
  const container = t.slice(i + 1).trim() || defaultContainerPath(host);
  return { host, container };
}

/** A mount as an editor line: the host path alone when the container path is its default. */
export function formatMount(m: Mount): string {
  return m.container === defaultContainerPath(m.host) ? m.host : `${m.host}:${m.container}`;
}

/** Problems with a list of mounts: relative paths and repeated container paths. */
export function mountProblems(mounts: readonly Mount[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mounts) {
    // The server doesn't expand `~`, so only an absolute path works.
    const hostProblem = hostPathProblem(m.host);
    if (hostProblem && /not an absolute/.test(hostProblem))
      out.push(
        `${m.host}: the host path must be absolute, such as /home/you/data or C:\\Users\\you\\data.`,
      );
    else if (hostProblem) out.push(hostProblem);
    if (!m.container.startsWith("/")) out.push(`${m.container}: the box path must be absolute.`);
    if (seen.has(m.container)) out.push(`${m.container}: two mounts use this box path.`);
    seen.add(m.container);
  }
  return out;
}

/** Parses a multi-line mount editor; returns the mounts or the problems. */
export function parseMountText(text: string): { mounts: Mount[]; problems: string[] } {
  const mounts = text
    .split("\n")
    .map(parseMountLine)
    .filter((m): m is Mount => m !== null);
  return { mounts, problems: mountProblems(mounts) };
}

/** Problems with TCP maps: out-of-range ports and repeated host ports. */
export function tcpMapProblems(maps: readonly { host: string; container: string }[]): string[] {
  const out: string[] = [];
  const seen = new Set<number>();
  for (const m of maps) {
    const host = Number(m.host);
    const container = m.container.trim() === "" ? host : Number(m.container);
    for (const [label, v] of [
      ["host", host],
      ["box", container],
    ] as const) {
      if (!Number.isInteger(v) || v < 1 || v > 65535)
        out.push(
          `The ${label} port "${label === "host" ? m.host : m.container}" is not a port number.`,
        );
    }
    if (seen.has(host)) out.push(`Host port ${host} is mapped twice.`);
    seen.add(host);
  }
  return out;
}

/** Turns editor rows into TCP maps; an empty box port mirrors the host port. */
export function toTcpMaps(rows: readonly { host: string; container: string }[]): TcpMap[] {
  return rows
    .filter((r) => r.host.trim() !== "")
    .map((r) => {
      const host = Number(r.host);
      return { host, container: r.container.trim() === "" ? host : Number(r.container) };
    });
}
