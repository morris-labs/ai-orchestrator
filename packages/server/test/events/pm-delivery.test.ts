// Delivery to the Project manager (#82): the server types each inbox item's
// pointer into the session of the build's box once the box runs and the
// session can take it, marks the item delivered in the engine, and leaves
// an item waiting, without an error, while the box is stopped.
import {
  pmPointer,
  type AioEvent,
  type BuildSummary,
  type PmInbox,
  type PmItem,
} from "@aio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryRequest, DeliveryResult } from "../../src/boxes/delivery.js";
import type { EngineCallInput } from "../../src/events/engine-client.js";
import { PmDelivery } from "../../src/events/pm-delivery.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const T0 = "2026-11-23T09:00:00.000Z";

const build: BuildSummary = {
  id: BUILD,
  slug: "cart-total",
  projectId: "proj-1",
  container: "aio-agent-proj-1",
  status: "waiting_escalation",
  step: "tasks",
  boxId: "box-pm",
  createdAt: T0,
  updatedAt: T0,
};

function item(id: string, ref: string): PmItem {
  return {
    id,
    kind: "escalation",
    ref,
    summary: `Escalation ${ref} (attempt_cap, for the project manager): Task T1 failed.`,
    file: `escalations/${ref}.json`,
    path: `/work/shop/.aio/builds/cart-total/escalations/${ref}.json`,
    needsAnswer: true,
    createdAt: T0,
    deliveredAt: null,
    answeredAt: null,
  };
}

/** An engine that keeps one build's inbox, and the boxes the server types into. */
function world(options: { running?: boolean; result?: DeliveryResult } = {}) {
  const items: PmItem[] = [];
  const calls: { key: string; input: EngineCallInput }[] = [];
  const engine = {
    call: async (key: string, input: EngineCallInput = {}) => {
      calls.push({ key, input });
      if (key === "engine.builds.inbox") {
        const inbox: PmInbox = {
          buildId: BUILD,
          slug: build.slug,
          boxId: build.boxId,
          items: items.map((i) => ({ ...i, pointer: pmPointer(build.slug, i) })),
        };
        return inbox;
      }
      if (key === "engine.builds.inbox.delivered") {
        const found = items.find((i) => i.id === input.params?.itemId);
        if (found) found.deliveredAt ??= "2026-11-23T09:05:00.000Z";
        return found;
      }
      throw new Error(`unexpected ${key}`);
    },
  };
  let running = options.running ?? true;
  const typed: { boxId: string; request: DeliveryRequest }[] = [];
  const logs: string[] = [];
  const delivery = new PmDelivery({
    builds: { list: () => [build], get: (id) => (id === BUILD ? build : undefined) },
    engines: {
      get: (container) => (container === build.container ? (engine as never) : undefined),
    },
    boxes: {
      deliver: async (boxId, request) => {
        if (!running)
          return { delivered: false, stopped: true, reason: `${boxId} is not running.` };
        typed.push({ boxId, request });
        return options.result ?? { delivered: true, confirmed: true };
      },
    },
    log: (m) => logs.push(m),
    retryMs: 60_000,
  });
  const added = (i: PmItem): AioEvent =>
    ({
      type: "build.inbox",
      buildId: BUILD,
      slug: build.slug,
      boxId: build.boxId,
      item: i,
    }) as AioEvent;
  return {
    items,
    calls,
    typed,
    logs,
    delivery,
    added,
    setRunning: (r: boolean) => (running = r),
  };
}

let open: PmDelivery | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

describe("delivery to the Project manager", () => {
  it("types one pointer for an escalation into the box's session and marks it delivered", async () => {
    const w = world();
    open = w.delivery;
    const i1 = item("I1", "E1");
    w.items.push(i1);

    w.delivery.ingest(w.added(i1));
    w.delivery.ingest(w.added(i1));
    await w.delivery.idle();

    expect(w.typed).toEqual([
      {
        boxId: "box-pm",
        request: {
          text: pmPointer("cart-total", i1),
          marker: "[aio-build cart-total I1]",
          claudeOnly: true,
        },
      },
    ]);
    expect(w.items[0]?.deliveredAt).not.toBeNull();
    expect(w.calls.filter((c) => c.key === "engine.builds.inbox.delivered")).toEqual([
      {
        key: "engine.builds.inbox.delivered",
        input: { params: { slug: "cart-total", itemId: "I1" } },
      },
    ]);
  });

  it("leaves an item waiting without an error while the box is stopped, and delivers it when the box starts", async () => {
    const w = world({ running: false });
    open = w.delivery;
    const i1 = item("I1", "E1");
    w.items.push(i1);

    w.delivery.ingest(w.added(i1));
    await w.delivery.idle();
    expect(w.typed).toEqual([]);
    expect(w.items[0]?.deliveredAt).toBeNull();
    expect(w.logs).toEqual([]);

    w.setRunning(true);
    w.delivery.ingest({ type: "box.changed", boxId: "box-pm", status: "running" } as AioEvent);
    await w.delivery.idle();
    expect(w.typed.map((t) => t.request.marker)).toEqual(["[aio-build cart-total I1]"]);
    expect(w.items[0]?.deliveredAt).not.toBeNull();
  });

  it("delivers the items a stopped server left waiting when it starts", async () => {
    const w = world();
    open = w.delivery;
    w.items.push({ ...item("I1", "E1"), deliveredAt: T0 }, item("I2", "E2"));

    w.delivery.start();
    await w.delivery.idle();

    expect(w.typed.map((t) => t.request.marker)).toEqual(["[aio-build cart-total I2]"]);
  });

  it("doesn't mark an item delivered when the transcript doesn't show it", async () => {
    const w = world({ result: { delivered: true, confirmed: false } });
    open = w.delivery;
    const i1 = item("I1", "E1");
    w.items.push(i1);

    w.delivery.ingest(w.added(i1));
    await w.delivery.idle();

    expect(w.typed).toHaveLength(1);
    expect(w.items[0]?.deliveredAt).toBeNull();
  });

  it("holds a usage alert for a stopped box until the box starts", async () => {
    const w = world({ running: false });
    open = w.delivery;

    w.delivery.alert("box-pm", "Usage alert: claude 5h window at 85%.");
    await w.delivery.idle();
    expect(w.typed).toEqual([]);

    w.setRunning(true);
    w.delivery.ingest({ type: "box.changed", boxId: "box-pm", status: "running" } as AioEvent);
    await w.delivery.idle();
    expect(w.typed).toEqual([
      { boxId: "box-pm", request: { text: "Usage alert: claude 5h window at 85%." } },
    ]);
  });
});
