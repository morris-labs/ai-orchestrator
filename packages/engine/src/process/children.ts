// Records the process groups the engine starts, so that an engine the keeper
// restarts after a crash can stop the ones the crashed engine left running.
// Every child runs in its own process group (`runProcess` starts it
// detached), so a vendor CLI outlives a crashed engine; without this, a
// resumed run starts a second fixer beside the orphaned one.
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";

/** One recorded process group: its leader's pid and the leader's start time. */
interface Entry {
  pgid: number;
  /** Field 22 of `/proc/PID/stat`, in clock ticks since boot. */
  start: string;
}

/** The record file's content. */
interface RecordFile {
  /**
   * The start time of pid 1, the container's keeper. A different value
   * means the container restarted, every recorded process is gone, and its
   * pids may belong to new processes.
   */
  instance: string;
  groups: Entry[];
}

/** Reads `/proc`. Replaced in tests. */
export interface ProcReader {
  /** The content of `/proc/PID/stat`, or `null` when the process is gone. */
  stat(pid: number): string | null;
  /** Every pid in `/proc`. */
  pids(): number[];
}

export const linuxProc: ProcReader = {
  stat(pid) {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return null;
    }
  },
  pids() {
    try {
      return readdirSync("/proc")
        .filter((name) => /^\d+$/.test(name))
        .map(Number);
    } catch {
      return [];
    }
  },
};

/** The process group and start time from a `/proc/PID/stat` line. */
export function parseStat(text: string): { pgrp: number; start: string } | null {
  // The command name is in parentheses and can hold spaces and parentheses.
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const pgrp = Number(fields[2]);
  const start = fields[19];
  if (!Number.isInteger(pgrp) || !start) return null;
  return { pgrp, start };
}

export class ChildRegistry {
  private readonly entries = new Map<number, Entry>();

  constructor(
    private readonly file: string,
    private readonly proc: ProcReader = linuxProc,
    private readonly kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) =>
      process.kill(pid, signal),
  ) {}

  /** Records the group that `pid` leads. Does nothing when `/proc` has no entry for it. */
  add(pid: number): void {
    const stat = this.proc.stat(pid);
    const parsed = stat ? parseStat(stat) : null;
    if (!parsed) return;
    this.entries.set(pid, { pgid: pid, start: parsed.start });
    this.save();
  }

  remove(pid: number): void {
    if (this.entries.delete(pid)) this.save();
  }

  /**
   * Kills the process groups that an earlier engine in the same container
   * recorded and that still run, then clears the record. A group counts as
   * the recorded one only when its leader has the recorded start time, or
   * when the leader is gone but members remain, since the kernel doesn't
   * reuse a pid that is still a group's id. Returns the number of groups it
   * killed.
   */
  reap(): number {
    let recorded: Partial<RecordFile> = {};
    try {
      recorded = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RecordFile>;
    } catch {
      // No record, or an unreadable one: nothing to reap.
    }
    const groups =
      recorded?.instance === this.instance() && Array.isArray(recorded.groups)
        ? recorded.groups
        : [];
    let killed = 0;
    for (const entry of groups) {
      if (!Number.isInteger(entry?.pgid) || entry.pgid <= 1) continue;
      if (!this.stillRunning(entry)) continue;
      try {
        this.kill(-entry.pgid, "SIGKILL");
        killed += 1;
      } catch {
        // Gone in the meantime.
      }
    }
    this.save();
    return killed;
  }

  private stillRunning(entry: Entry): boolean {
    const leader = this.proc.stat(entry.pgid);
    if (leader !== null) return parseStat(leader)?.start === entry.start;
    return this.proc.pids().some((pid) => {
      const stat = this.proc.stat(pid);
      return stat !== null && parseStat(stat)?.pgrp === entry.pgid;
    });
  }

  private instance(): string {
    const stat = this.proc.stat(1);
    return (stat && parseStat(stat)?.start) ?? "";
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const record: RecordFile = { instance: this.instance(), groups: [...this.entries.values()] };
    try {
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // A missing state directory leaves the engine without the record,
      // which only matters after a crash.
    }
  }
}

let active: ChildRegistry | null = null;

/** Sets the registry that `trackChild` records into; `null` turns recording off. */
export function setChildRegistry(registry: ChildRegistry | null): void {
  active = registry;
}

/** Records the process group that `pid` leads; the returned function forgets it. */
export function trackChild(pid: number): () => void {
  const registry = active;
  if (!registry) return () => undefined;
  registry.add(pid);
  return () => registry.remove(pid);
}
