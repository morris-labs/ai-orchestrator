// Polls the container's listeners and emits `ports.changed` when they change.
import type { Listener } from "@agentbox/contracts";
import type { EventSink, Logger } from "../api/core-interface.js";

export interface PortWatcherOptions {
  container: string;
  events: EventSink;
  log: Logger;
  scan: () => Promise<Listener[]>;
  intervalMs?: number;
}

export class PortWatcher {
  private current: Listener[] = [];
  private key = "[]";
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: PortWatcherOptions) {}

  /** The listeners from the newest scan. */
  list(): Listener[] {
    return this.current;
  }

  /** Scans once now, then every `intervalMs` (2 s by default). */
  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? 2_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Runs one scan, unless one is in progress, and emits on a change. */
  poll(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.scanOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async scanOnce(): Promise<void> {
    let listeners: Listener[];
    try {
      listeners = await this.options.scan();
    } catch (err) {
      this.options.log.warn("Port scan failed", { error: String(err) });
      return;
    }
    const key = JSON.stringify(listeners);
    if (key === this.key) return;
    this.key = key;
    this.current = listeners;
    this.options.log.debug("Listening ports changed", { ports: listeners.map((l) => l.port) });
    this.options.events.emit({
      type: "ports.changed",
      container: this.options.container,
      listeners,
    });
  }
}
