// Shared setup for the usage, scheduler, and notifier tests: an in-memory
// database, a settable clock, and a real event hub that validates every
// event against the contracts.
import { openDatabase } from "../../src/db/index.js";
import { randomUUID } from "node:crypto";
import {
  EventSchema,
  defaultConfig,
  type AioEvent,
  type GlobalSettings,
  type UsageSample,
  type Vendor,
} from "@aio/contracts";
import type { SqlDatabase } from "../../src/api/core-interface.js";
import { EventHub } from "../../src/events/hub.js";
import { UsageService } from "../../src/usage/usage-service.js";
import { UsageStore } from "../../src/usage/usage-store.js";

export const T0 = Date.parse("2026-10-28T09:00:00.000Z");
export const MIN = 60_000;
export const iso = (ms: number) => new Date(ms).toISOString();

export function setup() {
  const clock = { now: T0 };
  const now = () => new Date(clock.now);
  const db: SqlDatabase = openDatabase(":memory:");
  const hub = new EventHub({ now });
  const events: AioEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const settings: { value: GlobalSettings } = { value: defaultConfig() };
  const store = new UsageStore(db);
  const usage = new UsageService({
    store,
    settings: () => settings.value,
    emit: (e) => hub.emit(e),
    now,
  });
  const ofType = <T extends AioEvent["type"]>(type: T) =>
    events.filter((e): e is Extract<AioEvent, { type: T }> => e.type === type);

  let seq = 0;
  const samples: AioEvent[] = [];
  /** Builds a `usage.sample` event as an engine sends it and feeds it to the service. */
  function sample(vendor: Vendor, fields: Partial<UsageSample> = {}) {
    const ceiling = settings.value.ceilings[vendor];
    seq += 1;
    const event = EventSchema.parse({
      id: randomUUID(),
      time: iso(clock.now),
      source: "engine:aio-agent-proj-example-app-1a2b3c4d",
      streamId: "engine-stream",
      seq,
      sourceSeq: seq,
      type: "usage.sample",
      vendor,
      account: "me@example.com",
      window: ceiling.kind === "utilization" ? ceiling.window : "month",
      utilization: 0.1,
      spendUsd: null,
      ceiling,
      resetAt: iso(T0 + 300 * MIN),
      sampleSource: "rate_limit_event",
      ...fields,
    });
    usage.ingest(event);
    samples.push(event);
    return event;
  }

  return { clock, now, db, hub, events, ofType, settings, store, usage, sample, samples };
}
