// The store's REST snapshot: events applied while it loads win, and one
// run's failure keeps the rest of it.
import { ApiClient, type HttpRouteKey } from "@agentbox/ui/core";
import { FakeServer, makeEvent, type FakeHandler } from "@agentbox/ui/testing";
import { describe, expect, it, vi } from "vitest";
import { AppStore } from "../src/state/store.js";
import { BOX, CONTAINER, PROJECT, boxView, lastRun, project } from "./helpers/data.js";

function storeWith(handlers: Record<string, (req: { params: Record<string, string> }) => unknown>) {
  const server = new FakeServer();
  for (const [key, handler] of Object.entries(handlers)) {
    server.on(key as HttpRouteKey, handler as unknown as FakeHandler);
  }
  const api = new ApiClient({ fetch: server.fetch, token: "t", WebSocket: server.WebSocket });
  return new AppStore(api);
}

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
