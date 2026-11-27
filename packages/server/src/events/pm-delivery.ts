// Delivery to the Project manager: the server types each item of a build's
// inbox into the session of the build's box, as a one-line pointer to the
// item's file, and marks the item delivered in the engine. The engine keeps
// the inbox in the build's files, so nothing here needs to survive a
// restart: a starting server, a starting box, and a timer each read the
// inboxes again and deliver what waits.
//
// A stopped box leaves its items waiting, without an error. So does a
// session that can't take a message now, such as one that shows a dialog;
// see `boxes/delivery.ts`. A hand-off pointer goes into a cleared session:
// the server clears an idle session first, so the owner doesn't have to.
// An item counts as delivered once the session's
// transcript shows it, and the transcript's copy keeps a later attempt
// from typing it twice.
import {
  PmInboxSchema,
  pmMarker,
  pmPointer,
  type AioEvent,
  type BuildSummary,
  type PmItem,
} from "@aio/contracts";
import type { ApiEngines } from "../api/deps.js";
import type { DeliveryRequest, DeliveryResult } from "../boxes/delivery.js";

export interface PmDeliveryDeps {
  /** The mirrored builds of every project. */
  builds: { list(): BuildSummary[]; get(buildId: string): BuildSummary | undefined };
  engines: Pick<ApiEngines, "get">;
  boxes: { deliver(boxId: string, request: DeliveryRequest): Promise<DeliveryResult> };
  log: (message: string) => void;
  /** How often to try again for items that wait. Default: one minute. */
  retryMs?: number;
}

/** How many usage alerts wait for one box at most; older ones give way to newer ones. */
const ALERTS_PER_BOX = 5;

export class PmDelivery {
  /** One chain of deliveries per box, so two pointers never interleave. */
  private readonly chains = new Map<string, Promise<void>>();
  /** The builds whose inboxes may hold items that wait. */
  private readonly pending = new Set<string>();
  /** Usage alerts that wait for their box, by box. */
  private readonly alerts = new Map<string, string[]>();
  /** The last reason each item waited, so the log says it once. */
  private readonly reasons = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PmDeliveryDeps) {}

  /** Reads every build's inbox now and again on a timer, and delivers what waits. */
  start(): void {
    for (const build of this.deps.builds.list()) {
      if (build.boxId !== null) this.pending.add(build.id);
    }
    this.sweep();
    this.timer = setInterval(() => this.sweep(), this.deps.retryMs ?? 60_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Follows `build.inbox` and a box start; ignores every other event. */
  ingest(event: AioEvent): void {
    // The event's copy of the item can be stale by the time its turn comes,
    // so delivery reads the inbox from the engine.
    if (event.type === "build.inbox") {
      this.pending.add(event.buildId);
      if (event.boxId !== null) this.sweep(event.boxId);
      return;
    }
    if (event.type === "box.changed" && event.status === "running") {
      for (const build of this.deps.builds.list()) {
        if (build.boxId === event.boxId) this.pending.add(build.id);
      }
      this.sweep(event.boxId);
    }
  }

  /** Types a usage alert into box `boxId`'s session, or holds it until the box can take it. */
  alert(boxId: string, text: string): void {
    const waiting = [...(this.alerts.get(boxId) ?? []), text].slice(-ALERTS_PER_BOX);
    this.alerts.set(boxId, waiting);
    this.queue(boxId, () => this.deliverAlerts(boxId));
  }

  /** Resolves once every delivery under way has finished. */
  async idle(): Promise<void> {
    for (;;) {
      const chains = [...this.chains.values()];
      await Promise.all(chains);
      if ([...this.chains.values()].every((c, i) => c === chains[i])) return;
    }
  }

  private queue(boxId: string, work: () => Promise<void>): void {
    const next = (this.chains.get(boxId) ?? Promise.resolve()).then(work).catch((err: unknown) => {
      this.deps.log(`Delivery to box ${boxId} failed: ${(err as Error).message}`);
    });
    this.chains.set(boxId, next);
  }

  /** Reads the inboxes of the pending builds, of one box or all, and delivers what waits. */
  private sweep(boxId?: string): void {
    for (const [box, texts] of this.alerts) {
      if (texts.length > 0 && (boxId === undefined || box === boxId)) {
        this.queue(box, () => this.deliverAlerts(box));
      }
    }
    for (const id of this.pending) {
      const build = this.deps.builds.get(id);
      if (!build || build.boxId === null) {
        this.pending.delete(id);
        continue;
      }
      if (boxId !== undefined && build.boxId !== boxId) continue;
      const box = build.boxId;
      this.queue(box, () => this.deliverInbox(build, box));
    }
  }

  private async deliverInbox(build: BuildSummary, boxId: string): Promise<void> {
    const engine = this.deps.engines.get(build.container);
    // The container isn't running; its box starts it, and the box start sweeps again.
    if (!engine) return;
    const inbox = PmInboxSchema.parse(
      await engine.call("engine.builds.inbox", { params: { slug: build.slug } }),
    );
    const waiting = inbox.items.filter((i) => i.deliveredAt === null);
    if (waiting.length === 0) {
      this.pending.delete(build.id);
      return;
    }
    for (const item of waiting) {
      if (!(await this.deliverItem(build, boxId, item))) return;
    }
  }

  /** Delivers one item; returns false when the box can't take messages now. */
  private async deliverItem(build: BuildSummary, boxId: string, item: PmItem): Promise<boolean> {
    const engine = this.deps.engines.get(build.container);
    if (!engine) return false;
    const key = `${build.id}/${item.id}`;
    const result = await this.deps.boxes.deliver(boxId, {
      text: pmPointer(build.slug, item),
      marker: pmMarker(build.slug, item.id),
      // A hand-off starts a fresh Project manager session, so the server
      // clears the session first instead of asking the owner to.
      ...(item.kind === "handoff" ? { clear: true } : {}),
    });
    if (!result.delivered) {
      // A stopped box isn't worth a line: its start sweeps again.
      if (!result.stopped) this.waited(key, boxId, result.reason);
      return false;
    }
    // A pointer the transcript doesn't show yet stays undelivered: the next
    // attempt finds it in the transcript, or types it again.
    if (result.confirmed === false) {
      this.waited(key, boxId, "The session's transcript doesn't show the pointer yet.");
      return false;
    }
    this.reasons.delete(key);
    await engine.call("engine.builds.inbox.delivered", {
      params: { slug: build.slug, itemId: item.id },
    });
    return true;
  }

  private async deliverAlerts(boxId: string): Promise<void> {
    for (;;) {
      const [text] = this.alerts.get(boxId) ?? [];
      if (text === undefined) return;
      const result = await this.deps.boxes.deliver(boxId, { text });
      if (!result.delivered && result.unsupported) {
        // A session that never takes a message, such as a Codex session.
        this.deps.log(`Dropped the usage alerts for box ${boxId}: ${result.reason}`);
        this.alerts.delete(boxId);
        return;
      }
      if (!result.delivered) {
        if (!result.stopped) this.waited(`alert/${boxId}`, boxId, result.reason);
        return;
      }
      this.alerts.set(boxId, (this.alerts.get(boxId) ?? []).slice(1));
    }
  }

  /** Logs why an item waits, once for each reason. */
  private waited(key: string, boxId: string, reason: string): void {
    if (this.reasons.get(key) === reason) return;
    this.reasons.set(key, reason);
    this.deps.log(`A message for the Project manager in box ${boxId} waits: ${reason}`);
  }
}
