// Keeps a running box's record in step with its claude process (port of
// `SessionWatcher.cpp`). Claude Code keeps one `<pid>.json` per process in its
// sessions directory with the live `sessionId` and `name`, and rewrites it on
// `/clear` (a new session id) and `/rename`.
//
// Where the files are matters. Every container numbers its pids from the same
// small values, so a box reads its own directory, `~/.ai-orchestrator/sessions/<box>`,
// when that has entries; whatever is there is the box's. Otherwise the box
// reads its container's directory (`~/.ai-orchestrator/sessions/<container>`).
// A shared process is found by its recorded session id, then followed by
// `pid|pidDomain|procStart`. Host vendor session files are never consulted.
import fs from "node:fs";
import { BoxSchema, type Box } from "@aio/contracts";
import { readSessionEntries, sessionEntryKey, type SessionEntry } from "../catalog/sessions.js";
import type { BoxesRepo } from "../db/repositories.js";
import type { HostEnv } from "../records/env.js";
import { sessionsDirFor } from "../records/env.js";
import type { CoreEvents } from "../records/events.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Binding {
  /** Shared-directory mode only: the process key this box follows. */
  key: string;
  /** A first reading has been taken. */
  seen: boolean;
  lastSession: string;
  lastName: string;
}

export interface SessionWatcherOptions {
  env: HostEnv;
  boxes: BoxesRepo;
  events: CoreEvents;
  /** Delay between a file event and the scan it triggers. */
  debounceMs?: number;
  /** Interval of the backstop scan. */
  pollMs?: number;
}

export class SessionWatcher {
  private readonly env: HostEnv;
  private readonly boxes: BoxesRepo;
  private readonly events: CoreEvents;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private running = new Set<string>();
  private readonly bindings = new Map<string, Binding>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private started = false;
  private scanning: Promise<string[]> | undefined;
  private rescanWanted = false;

  constructor(options: SessionWatcherOptions) {
    this.env = options.env;
    this.boxes = options.boxes;
    this.events = options.events;
    this.debounceMs = options.debounceMs ?? 250;
    this.pollMs = options.pollMs ?? 3000;
  }

  /** Sets the boxes that are running and scans. Call it from the regular poll. */
  async setRunning(boxIds: readonly string[]): Promise<void> {
    this.running = new Set(boxIds);
    await this.scan();
  }

  /** Starts the file watchers and the backstop poll. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.pollTimer = setInterval(() => void this.scan().catch(() => undefined), this.pollMs);
    this.pollTimer.unref?.();
    void this.scan().catch(() => undefined);
  }

  /**
   * Returns the directories that have a live file watcher. A directory is
   * missing when the operating system refused the watch (for example, no
   * inotify instances are left); the backstop poll still covers it.
   */
  watchedDirs(): string[] {
    return [...this.watchers.keys()];
  }

  /** Stops every watcher and timer. */
  stop(): void {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = undefined;
    this.debounceTimer = undefined;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  /**
   * Reads the session files of every running box and applies what changed.
   * Concurrent calls share one scan, followed by one more if any arrived
   * during it. Returns the ids of the boxes whose record changed.
   */
  scan(): Promise<string[]> {
    if (this.scanning) {
      this.rescanWanted = true;
      return this.scanning;
    }
    const run = async (): Promise<string[]> => {
      const changed = new Set<string>();
      do {
        this.rescanWanted = false;
        for (const id of await this.scanOnce()) changed.add(id);
      } while (this.rescanWanted);
      return [...changed];
    };
    this.scanning = run().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private heldByOtherBox(sessionId: string, boxId: string): boolean {
    return this.boxes.bySession(sessionId).some((b) => b.id !== boxId);
  }

  private async scanOnce(): Promise<string[]> {
    const watchDirs = new Set<string>();
    const sharedDirs = new Map<string, Map<string, SessionEntry>>();
    const readShared = async (dir: string) => {
      let entries = sharedDirs.get(dir);
      if (!entries) {
        watchDirs.add(dir);
        entries = new Map((await readSessionEntries(dir)).map((e) => [sessionEntryKey(e), e]));
        sharedDirs.set(dir, entries);
      }
      return entries;
    };

    // A box that stopped has nothing to follow; it is read afresh when it
    // runs again.
    for (const id of [...this.bindings.keys()]) if (!this.running.has(id)) this.bindings.delete(id);

    const claimed = new Set<string>();
    for (const b of this.bindings.values()) if (b.key !== "") claimed.add(b.key);

    const changedIds: string[] = [];
    for (const boxId of this.running) {
      const rec = this.boxes.get(boxId);
      if (!rec) continue;

      let binding = this.bindings.get(boxId);
      if (!binding) {
        binding = { key: "", seen: false, lastSession: "", lastName: "" };
        this.bindings.set(boxId, binding);
      }
      let live: SessionEntry | undefined;
      let ownDir = false;

      // A box's own directory is mounted only when the box is its own
      // container (3.3.5 classic mode). In a shared container a leftover
      // directory from classic days holds stale files, never the live process.
      let mine: SessionEntry[] = [];
      if (rec.container === rec.id) {
        const boxDir = sessionsDirFor(this.env, boxId);
        watchDirs.add(boxDir);
        mine = await readSessionEntries(boxDir);
      }
      if (mine.length > 0) {
        ownDir = true;
        for (const e of mine) if (!live || e.updatedAt > live.updatedAt) live = e;
      } else {
        const all = await readShared(sessionsDirFor(this.env, rec.container));
        if (binding.key !== "") {
          live = all.get(binding.key);
          if (!live) {
            // The process is gone; find it again.
            binding = { key: "", seen: false, lastSession: "", lastName: "" };
            this.bindings.set(boxId, binding);
          }
        }
        if (!live && rec.sessionUuid) {
          let best: SessionEntry | undefined;
          for (const e of all.values()) {
            const key = sessionEntryKey(e);
            if (e.sessionId !== rec.sessionUuid || claimed.has(key)) continue;
            if (e.entrypoint === "claude-desktop") continue;
            if (!best || e.updatedAt > best.updatedAt) best = e;
          }
          if (best) {
            binding.key = sessionEntryKey(best);
            binding.seen = true;
            binding.lastSession = best.sessionId;
            binding.lastName = best.nameIsUser ? best.name : rec.conversationName;
            claimed.add(binding.key);
            continue; // matched by the record itself, so nothing changes yet
          }
        }
      }
      if (!live) continue;

      // Only changes since the previous reading are applied, so an edit
      // waiting for a restart is not reverted by the old process. The box's
      // own directory is certain, so its first reading is the truth.
      const first = !binding.seen;
      let changed = false;
      let seenSession = binding.lastSession;
      let seenName = binding.lastName;
      const next: Box = { ...rec };

      if (first ? ownDir : live.sessionId !== binding.lastSession) {
        seenSession = live.sessionId;
        // Another box holding the new id would mean two records for one
        // transcript; leave this record alone rather than pick a side.
        if (
          live.sessionId !== rec.sessionUuid &&
          UUID_RE.test(live.sessionId) &&
          !this.heldByOtherBox(live.sessionId, boxId)
        ) {
          next.sessionUuid = live.sessionId;
          changed = true;
        }
      } else if (first) {
        seenSession = live.sessionId;
      }

      // An auto-generated name is not something the user chose, so it never
      // replaces one they did.
      if (
        live.nameIsUser &&
        live.name !== "" &&
        (first ? ownDir : live.name !== binding.lastName)
      ) {
        seenName = live.name;
        if (live.name !== rec.conversationName) {
          next.conversationName = live.name;
          next.transcriptSyncedName = live.name;
          changed = true;
        }
      } else if (first) {
        seenName = rec.conversationName;
      }

      let saved: Box | undefined;
      if (changed) {
        // The reads above await, so an edit can land between the first get
        // and this put. Apply only the fields the watcher owns on top of the
        // record as it stands now, so that edit survives.
        const fresh = this.boxes.get(boxId);
        if (!fresh) continue;
        const update: Box = { ...fresh };
        if (next.sessionUuid !== rec.sessionUuid) update.sessionUuid = next.sessionUuid;
        if (next.conversationName !== rec.conversationName) {
          update.conversationName = next.conversationName;
          update.transcriptSyncedName = next.transcriptSyncedName;
        }
        try {
          saved = this.boxes.put(
            BoxSchema.parse({ ...update, updatedAt: this.env.now().toISOString() }),
          );
        } catch {
          continue; // keep the old state so the next scan retries
        }
      }
      binding.seen = true;
      binding.lastSession = seenSession;
      binding.lastName = seenName;
      if (saved) {
        changedIds.push(boxId);
        this.events.publish({ type: "box.changed", boxId, status: "running", box: saved });
      }
    }

    if (this.started) this.watch(watchDirs);
    return changedIds;
  }

  private schedule(): void {
    if (!this.started) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.scan().catch(() => undefined);
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  /** Watches each existing directory in `dirs`; missing ones are retried on the next scan. */
  private watch(dirs: Set<string>): void {
    for (const [dir, w] of this.watchers) {
      if (!dirs.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const w = fs.watch(dir, { persistent: false }, () => this.schedule());
        w.on("error", () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {
        // Not there yet.
      }
    }
  }
}
