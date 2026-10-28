// Finds listening TCP sockets in the container and the tmux session (and so
// the box) that owns each one. `ss -ltnpH` is the primary source;
// `/proc/net/tcp` and `/proc/net/tcp6` are the fallback.
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import type { Listener } from "@agentbox/contracts";
import type { CommandRunner } from "../api/runner.js";

/** A listening socket before it is mapped to a box. */
export interface RawListener {
  port: number;
  proto: "tcp" | "tcp6";
  process: string | null;
  pid: number | null;
  /** The socket inode, from `/proc`; `null` from `ss`. */
  inode?: string | null;
}

/** The parts of `/proc` the scanner reads; tests replace it. */
export interface ProcFs {
  readFile(path: string): string | null;
  readdir(path: string): string[];
  readlink(path: string): string | null;
}

export const realProcFs: ProcFs = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  readdir(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  readlink(path) {
    try {
      return readlinkSync(path);
    } catch {
      return null;
    }
  },
};

/** Parses `ss -ltnpH` output. Lines that aren't listeners are skipped. */
export function parseSs(output: string): RawListener[] {
  const out: RawListener[] = [];
  for (const line of output.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== "LISTEN") continue;
    const local = cols[3] ?? "";
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const port = Number(local.slice(colon + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const addr = local.slice(0, colon);
    const proto = addr.startsWith("[") || addr === "*" || addr.includes(":") ? "tcp6" : "tcp";
    const users = cols.slice(5).join(" ");
    const m = /\(\("([^"]*)",pid=(\d+)/.exec(users);
    out.push({ port, proto, process: m?.[1] ?? null, pid: m ? Number(m[2]) : null });
  }
  return out;
}

/** Parses `/proc/net/tcp` or `/proc/net/tcp6`; keeps sockets in state `0A` (LISTEN). */
export function parseProcNetTcp(content: string, proto: "tcp" | "tcp6"): RawListener[] {
  const out: RawListener[] = [];
  for (const line of content.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== "0A") continue;
    const portHex = (cols[1] ?? "").split(":")[1];
    if (!portHex) continue;
    const port = parseInt(portHex, 16);
    if (!(port >= 1 && port <= 65535)) continue;
    out.push({ port, proto, process: null, pid: null, inode: cols[9] ?? null });
  }
  return out;
}

/** Maps socket inodes to pids by reading `/proc/<pid>/fd`. */
export function socketOwners(proc: ProcFs, inodes: Set<string>): Map<string, number> {
  const owners = new Map<string, number>();
  if (inodes.size === 0) return owners;
  for (const entry of proc.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    for (const fd of proc.readdir(`/proc/${entry}/fd`)) {
      const target = proc.readlink(`/proc/${entry}/fd/${fd}`);
      const m = target ? /^socket:\[(\d+)\]$/.exec(target) : null;
      if (m && inodes.has(m[1] as string) && !owners.has(m[1] as string)) {
        owners.set(m[1] as string, Number(entry));
      }
    }
    if (owners.size === inodes.size) break;
  }
  return owners;
}

/** Reads the parent pid from `/proc/<pid>/stat`, or `null`. */
export function parentPid(proc: ProcFs, pid: number): number | null {
  const stat = proc.readFile(`/proc/${pid}/stat`);
  if (!stat) return null;
  // The command name is in parentheses and can hold spaces; fields follow the last ")".
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

/** Parses `tmux list-panes -a -F '#{session_name}\t#{pane_pid}'` into pane pid to session. */
export function parsePanes(output: string): Map<number, string> {
  const panes = new Map<number, string>();
  for (const line of output.split("\n")) {
    const tab = line.lastIndexOf("\t");
    if (tab < 0) continue;
    const pid = Number(line.slice(tab + 1));
    if (Number.isInteger(pid) && pid > 0) panes.set(pid, line.slice(0, tab));
  }
  return panes;
}

const SIDE_SUFFIX = /-(claude|codex|copilot)$/;

/**
 * The box a tmux session belongs to. A box's main session is named after the
 * box (`claude-agent-...`); a side session is `<main>-<platform>`, which
 * counts only when `<main>` is itself a live session.
 */
export function sessionToBoxId(session: string, liveSessions: Set<string>): string | null {
  const main = session.replace(SIDE_SUFFIX, "");
  const name = main !== session && liveSessions.has(main) ? main : session;
  return name.startsWith("claude-agent-") ? name : null;
}

export interface ScannerOptions {
  runner: CommandRunner;
  proc?: ProcFs;
  /** Ports to leave out, such as the engine's own. */
  excludePorts?: number[];
}

/** Lists the container's listeners, each mapped to a box when its process tree reaches a tmux pane. */
export async function scanListeners(options: ScannerOptions): Promise<Listener[]> {
  const proc = options.proc ?? realProcFs;
  let raw: RawListener[];
  const ss = await options.runner.run("ss", ["-ltnpH"], { timeoutMs: 5_000 });
  if (ss.code === 0) {
    raw = parseSs(ss.stdout);
  } else {
    raw = [
      ...parseProcNetTcp(proc.readFile("/proc/net/tcp") ?? "", "tcp"),
      ...parseProcNetTcp(proc.readFile("/proc/net/tcp6") ?? "", "tcp6"),
    ];
    const inodes = new Set(raw.map((r) => r.inode).filter((i): i is string => !!i && i !== "0"));
    const owners = socketOwners(proc, inodes);
    for (const r of raw) {
      r.pid = r.inode ? (owners.get(r.inode) ?? null) : null;
      if (r.pid !== null) r.process = proc.readFile(`/proc/${r.pid}/comm`)?.trim() || null;
    }
  }

  const panesOut = await options.runner.run(
    "tmux",
    ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"],
    { timeoutMs: 5_000 },
  );
  const panes = panesOut.code === 0 ? parsePanes(panesOut.stdout) : new Map<number, string>();
  const live = new Set(panes.values());

  const sessionOf = (pid: number | null): string | null => {
    const seen = new Set<number>();
    let current = pid;
    while (current !== null && current > 1 && !seen.has(current)) {
      const session = panes.get(current);
      if (session !== undefined) return session;
      seen.add(current);
      current = parentPid(proc, current);
    }
    return null;
  };

  const exclude = new Set(options.excludePorts ?? []);
  const byKey = new Map<string, Listener>();
  for (const r of raw) {
    if (exclude.has(r.port)) continue;
    const key = `${r.port}/${r.proto}`;
    if (byKey.has(key)) continue;
    const session = sessionOf(r.pid);
    byKey.set(key, {
      port: r.port,
      proto: r.proto,
      process: r.process,
      boxId: session === null ? null : sessionToBoxId(session, live),
    });
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}
