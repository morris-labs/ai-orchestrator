// The store's REST snapshot: events applied while it loads win, and one
// run's failure keeps the rest of it.
import { ApiClient, type HttpRouteKey } from "@agentbox/ui/core";
import { FakeServer, makeEvent, type FakeHandler } from "@agentbox/ui/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStore, SNAPSHOT_RETRY_MS, SNAPSHOT_RUN_CONCURRENCY } from "../src/state/store.js";
import { BOX, CONTAINER, PROJECT, boxView, lastRun, project } from "./helpers/data.js";

type Handlers = Record<string, (req: { params: Record<string, string> }) => unknown>;

function serverWith(handlers: Handlers) {
  const server = new FakeServer();
  for (const [key, handler] of Object.entries(handlers)) {
    server.on(key as HttpRouteKey, handler as unknown as FakeHandler);
  }
  const api = new ApiClient({ fetch: server.fetch, token: "t", WebSocket: server.WebSocket });
  return { server, store: new AppStore(api, () => clock) };
}

function storeWith(handlers: Handlers) {
  return serverWith(handlers).store;
}

/** The time the stores' clock reads. */
let clock = Date.parse("2026-10-28T10:00:00Z");

/** Sends a hello for another stream, as a server that can't replay does. */
function resetStream(server: FakeServer) {
  const socket = server.socketsFor("/api/v1/events")[0];
  if (!socket) throw new Error("No event stream is open.");
  socket.serverSend({ type: "hello", streamId: "another-stream", lastSeq: 0, replaying: false });
}

afterEach(() => {
  vi.useRealTimers();
});

const OK_ID = "01JB8Z5K3W6Q2V9X4T7R0M1N2A";
const GONE_ID = "01JB8Z5K3W6Q2V9X4T7R0M1N2B";

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

describe("AppStore.loadSnapshot", () => {
  // Finding 29: `seedDashboard` used to bring back a box or container that
  // an event removed while the snapshot loaded.
  it("doesn't bring back a box or container removed while it loads", async () => {
    const g = gate();
    const store = storeWith({
      "runs.list": () => ({ runs: [] }),
      "projects.list": () => ({ projects: [project] }),
      "boxes.list": async () => {
        await g.opened;
        return { boxes: [boxView()] };
      },
    });
    const loading = store.loadSnapshot();
    store.ingest(makeEvent("box.changed", { boxId: BOX, status: "stopped", box: null }));
    store.ingest(
      makeEvent("container.changed", {
        container: CONTAINER,
        projectId: PROJECT,
        state: "removed",
        engine: null,
      }),
    );
    g.open();
    await loading;
    const { dashboard } = store.getState();
    expect(dashboard.boxes[BOX]).toBeUndefined();
    expect(dashboard.containers[CONTAINER]).toBeUndefined();
  });

  it("keeps a box that came back after its removal while it loads", async () => {
    const g = gate();
    const store = storeWith({
      "runs.list": () => ({ runs: [] }),
      "projects.list": () => ({ projects: [] }),
      "boxes.list": async () => {
        await g.opened;
        return { boxes: [boxView()] };
      },
    });
    const loading = store.loadSnapshot();
    store.ingest(makeEvent("box.changed", { boxId: BOX, status: "stopped", box: null }));
    store.ingest(makeEvent("box.changed", { boxId: BOX, status: "running", box: boxView().box }));
    g.open();
    await loading;
    expect(store.getState().dashboard.boxes[BOX]).toBe("running");
  });

  it("seeds boxes and containers from a snapshot with no removals", async () => {
    const store = storeWith({
      "runs.list": () => ({ runs: [] }),
      "projects.list": () => ({ projects: [project] }),
      "boxes.list": () => ({ boxes: [boxView()] }),
    });
    await store.loadSnapshot();
    const { dashboard } = store.getState();
    expect(dashboard.boxes[BOX]).toBe("running");
    expect(dashboard.containers[CONTAINER]?.state).toBe("running");
  });

  // Finding 30: `Promise.all` used to drop the whole snapshot on one failure.
  it("keeps the snapshot when one run's details fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ok = { ...lastRun(), id: OK_ID, status: "running" as const };
    const gone = { ...lastRun(), id: GONE_ID, status: "running" as const };
    const store = storeWith({
      "runs.list": () => ({ runs: [ok, gone] }),
      "projects.list": () => ({ projects: [project] }),
      "boxes.list": () => ({ boxes: [boxView()] }),
      "runs.rounds": (req) => {
        if (req.params.runId === GONE_ID) throw new Error("The run is gone.");
        return { rounds: [] };
      },
      "findings.list": () => ({ findings: [] }),
    });
    await store.loadSnapshot();
    const { dashboard, error } = store.getState();
    expect(Object.keys(dashboard.runs).sort()).toEqual([GONE_ID, OK_ID].sort());
    expect(dashboard.boxes[BOX]).toBe("running");
    expect(error).toMatch(
      /Couldn't load the rounds and findings of 1 run\(s\): 01JB8Z5K3W6Q2V9X4T7R0M1N2B/,
    );
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

/** Ten open runs with distinct ids. */
function openRuns() {
  return Array.from({ length: 10 }, (_, i) => ({
    ...lastRun(),
    id: `01JB8Z5K3W6Q2V9X4T7R0M1N${String(i).padStart(2, "0")}`,
    status: "running" as const,
  }));
}

describe("AppStore snapshot timing and errors", () => {
  // Finding 27: the time used to be read after every call had finished.
  it("dates the snapshot from when the load started", async () => {
    const g = gate();
    clock = Date.parse("2026-10-28T10:00:00Z");
    const store = storeWith({
      "runs.list": () => ({ runs: [] }),
      "projects.list": () => ({ projects: [project] }),
      "boxes.list": async () => {
        await g.opened;
        return { boxes: [] };
      },
    });
    const loading = store.loadSnapshot();
    clock = Date.parse("2026-10-28T10:05:00Z");
    g.open();
    await loading;
    expect(store.getState().dashboard.containers[CONTAINER]?.updatedAt).toBe(
      "2026-10-28T10:00:00.000Z",
    );
  });

  // Finding 33: a success used to leave an earlier failure on show.
  it("clears its own earlier error after a success", async () => {
    let fail = true;
    const store = storeWith({
      "runs.list": () => {
        if (fail) throw new Error("The server is starting.");
        return { runs: [] };
      },
      "projects.list": () => ({ projects: [] }),
      "boxes.list": () => ({ boxes: [] }),
    });
    await store.loadSnapshot();
    expect(store.getState().error).toMatch(/The server is starting/);
    fail = false;
    await store.loadSnapshot();
    expect(store.getState().error).toBeNull();
  });

  it("keeps an error that another load reported", async () => {
    const store = storeWith({
      "runs.list": () => ({ runs: [] }),
      "projects.list": () => ({ projects: [] }),
      "boxes.list": () => ({ boxes: [] }),
      "usage.get": () => {
        throw new Error("Usage is unavailable.");
      },
    });
    await store.loadUsage();
    await store.loadSnapshot();
    expect(store.getState().error).toMatch(/Usage is unavailable/);
  });

  // Finding 32: every open run used to get its two calls at once.
  it("loads at most a few runs' details at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async <T,>(value: T) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return value;
    };
    const store = storeWith({
      "runs.list": () => ({ runs: openRuns() }),
      "projects.list": () => ({ projects: [] }),
      "boxes.list": () => ({ boxes: [] }),
      "runs.rounds": () => slow({ rounds: [] }),
      "findings.list": () => slow({ findings: [] }),
    });
    await store.loadSnapshot();
    expect(Object.keys(store.getState().dashboard.runs)).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(SNAPSHOT_RUN_CONCURRENCY * 2);
  });

  it("starts no more run calls once a newer load replaces it", async () => {
    const g = gate();
    let first = true;
    const { server, store } = serverWith({
      "runs.list": () => {
        const runs = first ? openRuns() : [];
        first = false;
        return { runs };
      },
      "projects.list": () => ({ projects: [] }),
      "boxes.list": () => ({ boxes: [] }),
      "runs.rounds": async () => {
        await g.opened;
        return { rounds: [] };
      },
      "findings.list": () => ({ findings: [] }),
    });
    const older = store.loadSnapshot();
    await vi.waitFor(() =>
      expect(server.callsTo("runs.rounds")).toHaveLength(SNAPSHOT_RUN_CONCURRENCY),
    );
    await store.loadSnapshot();
    g.open();
    await older;
    expect(server.callsTo("runs.rounds")).toHaveLength(SNAPSHOT_RUN_CONCURRENCY);
  });
});

describe("AppStore resync", () => {
  // Finding 28: the store used to empty the dashboard and tell screens about
  // the reset before the new snapshot arrived.
  it("tells screens about a reset only once the new snapshot applies", async () => {
    const g = gate();
    let loads = 0;
    const { server, store } = serverWith({
      "runs.list": () => ({ runs: [] }),
      "projects.list": () => ({ projects: [] }),
      "boxes.list": async () => {
        loads += 1;
        if (loads === 1) return { boxes: [boxView()] };
        await g.opened;
        return { boxes: [] };
      },
    });
    const heard: number[] = [];
    store.hub.onResync(() => heard.push(store.getState().resets));
    store.start();
    await vi.waitFor(() => expect(store.getState().dashboard.boxes[BOX]).toBe("running"));
    resetStream(server);
    await vi.waitFor(() => expect(loads).toBe(2));
    expect(store.getState().dashboard.boxes[BOX]).toBe("running");
    expect(store.getState().resets).toBe(0);
    expect(heard).toEqual([]);
    g.open();
    await vi.waitFor(() => expect(store.getState().resets).toBe(1));
    expect(store.getState().dashboard.boxes[BOX]).toBeUndefined();
    expect(heard).toEqual([1]);
    store.stop();
  });

  it("keeps the events that arrive during the reset's snapshot load", async () => {
    const g = gate();
    let loads = 0;
    const { server, store } = serverWith({
      "runs.list": () => ({ runs: [] }),
      "projects.list": () => ({ projects: [] }),
      "boxes.list": async () => {
        loads += 1;
        if (loads > 1) await g.opened;
        return { boxes: [] };
      },
    });
    store.start();
    await vi.waitFor(() => expect(loads).toBe(1));
    resetStream(server);
    await vi.waitFor(() => expect(loads).toBe(2));
    store.ingest(makeEvent("box.changed", { boxId: BOX, status: "running", box: boxView().box }));
    g.open();
    await vi.waitFor(() => expect(store.getState().resets).toBe(1));
    expect(store.getState().dashboard.boxes[BOX]).toBe("running");
    store.stop();
  });

  // Finding 31: a failed load used to leave nothing applied, with no retry.
  it("retries a failed snapshot load while the stream runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let fail = true;
    const { store } = serverWith({
      "runs.list": () => {
        if (fail) throw new Error("The server is starting.");
        return { runs: [] };
      },
      "projects.list": () => ({ projects: [] }),
      "boxes.list": () => ({ boxes: [boxView()] }),
    });
    store.start();
    await vi.waitFor(() => expect(store.getState().error).toMatch(/starting/));
    fail = false;
    await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_MS);
    await vi.waitFor(() => expect(store.getState().dashboard.boxes[BOX]).toBe("running"));
    expect(store.getState().error).toBeNull();
    store.stop();
  });

  // Finding 34: a load still in flight used to apply to a stopped store.
  it("drops a snapshot that finishes after stop", async () => {
    const g = gate();
    const store = storeWith({
      "runs.list": () => ({ runs: [] }),
      "projects.list": () => ({ projects: [] }),
      "boxes.list": async () => {
        await g.opened;
        return { boxes: [boxView()] };
      },
    });
    store.start();
    const loading = store.loadSnapshot();
    store.stop();
    g.open();
    await loading;
    expect(store.getState().dashboard.boxes[BOX]).toBeUndefined();
  });
});
