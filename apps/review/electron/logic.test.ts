import type { AioEvent, Machine, RunState } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import {
  ActiveRuns,
  ERR_ABORTED,
  FleetActiveRuns,
  type MachineStreamHandlers,
  PendingNavigation,
  launcherHash,
  lostAppPage,
  noticeFor,
  offlinePageUrl,
  parseDeepLink,
  Reloader,
  rendererUrl,
  STALE_NOTICE_MS,
  trayBitmap,
  trayTooltip,
} from "./logic.js";

describe("parseDeepLink", () => {
  it.each([
    [["electron", "."], null],
    [["app", "aio-review://launch?project=p1&box=b1"], { project: "p1", box: "b1", machine: null }],
    [["app", "?project=p1"], { project: "p1", box: null, machine: null }],
    [["app", "--box=aio-agent-x"], { project: null, box: "aio-agent-x", machine: null }],
    // What the boxes app passes for Start Review.
    [
      ["aio-review", "--project=example-app-1a2b3c4d", "--box=aio-agent-x"],
      { project: "example-app-1a2b3c4d", box: "aio-agent-x", machine: null },
    ],
    // And for a box on another machine.
    [
      ["aio-review", "--project=p1", "--box=aio-agent-x", "--machine=node-b"],
      { project: "p1", box: "aio-agent-x", machine: "node-b" },
    ],
    [
      ["app", "aio-review://launch?project=p1&box=b1&machine=node-b"],
      { project: "p1", box: "b1", machine: "node-b" },
    ],
    [["app", "--project=", "--box="], null],
    [["app", "--machine=node-b"], null],
    [["app", "aio-review://launch"], null],
  ])("%j", (argv, want) => {
    expect(parseDeepLink(argv)).toEqual(want);
  });
});

describe("renderer URLs", () => {
  it("opens the launcher with the deep link", () => {
    expect(rendererUrl("http://127.0.0.1:21400/", { project: "p", box: null, machine: null })).toBe(
      "http://127.0.0.1:21400/review/?project=p#/launch",
    );
    expect(rendererUrl("http://127.0.0.1:21400", null)).toBe("http://127.0.0.1:21400/review/");
    expect(launcherHash({ project: "p", box: "b", machine: null })).toBe(
      "#/launch?project=p&box=b",
    );
    expect(launcherHash({ project: "p", box: "b", machine: "node-b" })).toBe(
      "#/launch?project=p&box=b&machine=node-b",
    );
    expect(rendererUrl("http://127.0.0.1:21400", { project: "p", box: "b", machine: "m1" })).toBe(
      "http://127.0.0.1:21400/review/?project=p&box=b&machine=m1#/launch",
    );
  });
});

const run = (id: string, status: RunState["status"]) => ({ id, status }) as RunState;
const changed = (r: RunState) =>
  ({ type: "run.changed", run: r, roundSummary: null }) as unknown as AioEvent;

describe("ActiveRuns", () => {
  it("counts active runs from the list and the events", () => {
    const a = new ActiveRuns();
    a.seed([run("1", "running"), run("2", "finished"), run("3", "waiting_decision")]);
    expect(a.count).toBe(2);
    expect(a.apply(changed(run("1", "finished")))).toBe(true);
    expect(a.apply(changed(run("3", "paused")))).toBe(false);
    expect(a.apply({ type: "notification" } as AioEvent)).toBe(false);
    expect(a.count).toBe(1);
  });

  // Finding 21: a list that started before an event used to overwrite it.
  it("keeps events that arrived while the list loaded", () => {
    const a = new ActiveRuns();
    a.seed([run("1", "running")]);
    const since = a.mark();
    a.apply(changed(run("1", "finished")));
    a.apply(changed(run("2", "running")));
    // The list was taken before both events.
    a.seed([run("1", "running"), run("3", "running")], since);
    expect(a.count).toBe(2);
    expect(a.apply(changed(run("2", "finished")))).toBe(true);
    expect(a.apply(changed(run("3", "finished")))).toBe(true);
    expect(a.count).toBe(0);
  });

  it("takes a list that started after every event as the truth", () => {
    const a = new ActiveRuns();
    a.apply(changed(run("1", "running")));
    a.seed([run("2", "running")], a.mark());
    expect(a.count).toBe(1);
    expect(a.apply(changed(run("2", "finished")))).toBe(true);
  });
});

describe("Reloader", () => {
  function fakeTimers() {
    const pending: { fn: () => void; ms: number }[] = [];
    return {
      pending,
      timers: {
        set: (fn: () => void, ms: number) => {
          const t = { fn, ms };
          pending.push(t);
          return t;
        },
        clear: (h: unknown) => {
          const i = pending.indexOf(h as (typeof pending)[number]);
          if (i >= 0) pending.splice(i, 1);
        },
      },
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // Finding 20: a failed reload used to be dropped until the next resync.
  it("runs a failed load again with backoff until it succeeds", async () => {
    const { pending, timers } = fakeTimers();
    let calls = 0;
    const r = new Reloader(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("starting");
      },
      timers,
      100,
      1000,
    );
    r.request();
    await settle();
    expect(pending.map((t) => t.ms)).toEqual([100]);
    pending.shift()!.fn();
    await settle();
    expect(pending.map((t) => t.ms)).toEqual([200]);
    pending.shift()!.fn();
    await settle();
    expect(calls).toBe(3);
    expect(pending).toEqual([]);
  });

  it("replaces a waiting retry on request and stops for good on stop", async () => {
    const { pending, timers } = fakeTimers();
    let calls = 0;
    const r = new Reloader(
      async () => {
        calls += 1;
        throw new Error("down");
      },
      timers,
      100,
    );
    r.request();
    await settle();
    r.request();
    await settle();
    expect(pending.map((t) => t.ms)).toEqual([100]);
    r.stop();
    expect(pending).toEqual([]);
    expect(calls).toBe(2);
  });
});

describe("noticeFor", () => {
  const on = {
    decisionNeeded: true,
    runFinished: true,
    readyToPush: true,
    boxEnded: true,
    roundSummary: true,
  };
  const notification = (kind: string, extra: object = {}) =>
    ({
      type: "notification",
      notificationId: "n",
      kind,
      title: "T",
      body: "B",
      runId: "01JB8Z5K3W6Q2V9X4T7R0M1N2P",
      boxId: null,
      severity: "info",
      read: false,
      ...extra,
    }) as unknown as AioEvent;

  it.each([
    ["decision_needed", on, "#/runs/01JB8Z5K3W6Q2V9X4T7R0M1N2P", true],
    ["run_finished", on, "#/runs/01JB8Z5K3W6Q2V9X4T7R0M1N2P", false],
    ["ready_to_push", on, "#/runs/01JB8Z5K3W6Q2V9X4T7R0M1N2P", false],
    ["ready_to_push", { ...on, readyToPush: false }, null, false],
    ["ready_to_push", { ...on, runFinished: false }, "#/runs/01JB8Z5K3W6Q2V9X4T7R0M1N2P", false],
    ["round_summary", { ...on, roundSummary: false }, null, false],
    ["box_ended", on, null, false],
  ])("%s", (kind, toggles, hash, urgent) => {
    const n = noticeFor(notification(kind), toggles);
    if (hash === null) expect(n).toBeNull();
    else expect(n).toMatchObject({ hash, urgent, title: "T" });
  });

  it("skips read notifications and opens the run list without a run", () => {
    expect(noticeFor(notification("run_finished", { read: true }), on)).toBeNull();
    expect(noticeFor(notification("run_finished", { runId: null }), on)?.hash).toBe("#/runs");
  });

  // Finding 18: a reconnect's replay used to pop up every missed notification.
  it("skips notifications older than the stale limit", () => {
    const time = "2026-10-28T10:00:00.000Z";
    const at = Date.parse(time);
    const n = notification("run_finished", { time });
    expect(noticeFor(n, on, at + STALE_NOTICE_MS)).not.toBeNull();
    expect(noticeFor(n, on, at + STALE_NOTICE_MS + 1)).toBeNull();
  });
});

describe("noticeFor on several machines", () => {
  const on = {
    decisionNeeded: true,
    runFinished: true,
    readyToPush: true,
    boxEnded: true,
    roundSummary: true,
  };
  const decision = {
    type: "notification",
    notificationId: "n",
    kind: "decision_needed",
    title: "Decision needed",
    body: "B",
    runId: "01JB8Z5K3W6Q2V9X4T7R0M1N2P",
    boxId: null,
    severity: "warning",
    read: false,
  } as unknown as AioEvent;

  it("names another machine and opens the run on it", () => {
    expect(
      noticeFor(decision, on, undefined, { id: "m 1", name: "build-server", isLocal: false }),
    ).toMatchObject({
      title: "build-server: Decision needed",
      hash: "#/runs/01JB8Z5K3W6Q2V9X4T7R0M1N2P?machine=m%201",
      urgent: true,
    });
  });

  it("names this machine and opens the run here", () => {
    expect(
      noticeFor(decision, on, undefined, { id: "local", name: "main-pc", isLocal: true }),
    ).toMatchObject({
      title: "main-pc: Decision needed",
      hash: "#/runs/01JB8Z5K3W6Q2V9X4T7R0M1N2P",
    });
  });
});

describe("FleetActiveRuns", () => {
  const machine = (over: Partial<Machine>) =>
    ({
      role: "node",
      status: "online",
      isLocal: false,
      serverVersion: "1.0.0",
      protocol: 1,
      capabilities: [],
      lastSeen: null,
      platform: "linux",
      ...over,
    }) as Machine;
  const LOCAL = machine({ id: "local", name: "main-pc", role: "both", isLocal: true });
  const BUILD = machine({ id: "m1", name: "build-server" });
  const LAPTOP = machine({ id: "m2", name: "laptop", status: "offline" });
  const OLD = machine({ id: "m3", name: "old-pc", status: "revoked" });

  /** Waits for the promises the fleet started to settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  function setup(machines: Machine[] | Error, runs: Record<string, RunState[]>) {
    const streams = new Map<string, { handlers: MachineStreamHandlers; stopped: boolean }>();
    const notices: [string, AioEvent][] = [];
    const listed: string[] = [];
    let counts = 0;
    const intervals: { fn: () => void; cleared: boolean }[] = [];
    const state = { machines };
    const fleet = new FleetActiveRuns({
      listMachines: async () => {
        if (state.machines instanceof Error) throw state.machines;
        return state.machines;
      },
      listRuns: async (id) => {
        listed.push(id);
        return runs[id] ?? [];
      },
      connect: (id, handlers) => {
        const s = { handlers, stopped: false };
        streams.set(id, s);
        return { stop: () => void (s.stopped = true) };
      },
      onCount: () => void (counts += 1),
      onNotification: (m, e) => void notices.push([m.name, e]),
      setInterval: (fn) => {
        const t = { fn, cleared: false };
        intervals.push(t);
        return t;
      },
      clearInterval: (t) => void ((t as { cleared: boolean }).cleared = true),
    });
    return { fleet, streams, notices, listed, intervals, state, counts: () => counts };
  }

  it("counts the active runs of this machine and every online machine", async () => {
    const { fleet, streams, listed, counts } = setup([LOCAL, BUILD, LAPTOP, OLD], {
      m1: [run("r1", "running"), run("r2", "waiting_decision"), run("r3", "finished")],
    });
    fleet.local.seed([run("a", "running")]);
    await fleet.refresh();
    await settle();
    // No stream or list for an offline or a revoked machine.
    expect(fleet.machineIds).toEqual(["m1"]);
    expect([...streams.keys()]).toEqual(["m1"]);
    expect(listed).toEqual(["m1"]);
    expect(fleet.count).toBe(3);
    expect(counts()).toBe(1);

    // The machine's event stream keeps its count current.
    streams.get("m1")!.handlers.onEvent(changed(run("r2", "finished")));
    expect(fleet.count).toBe(2);
    expect(counts()).toBe(2);

    // A resync reloads that machine's runs.
    streams.get("m1")!.handlers.onResync();
    await settle();
    expect(listed).toEqual(["m1", "m1"]);
  });

  it("passes on another machine's notifications with the machine", async () => {
    const { fleet, streams, notices } = setup([LOCAL, BUILD], {});
    expect(fleet.localNoticeMachine()).toBeUndefined();
    await fleet.refresh();
    const event = { type: "notification", kind: "decision_needed" } as unknown as AioEvent;
    streams.get("m1")!.handlers.onEvent(event);
    expect(notices).toEqual([["build-server", event]]);
    // With another machine followed, this machine's notices name it too.
    expect(fleet.localNoticeMachine()).toEqual({ id: "local", name: "main-pc", isLocal: true });
  });

  it("stops counting a machine as soon as it goes offline or is revoked", async () => {
    const { fleet, streams, state, counts } = setup([LOCAL, BUILD], {
      m1: [run("r1", "running")],
    });
    await fleet.refresh();
    await settle();
    expect(fleet.count).toBe(1);
    const stream = streams.get("m1")!;

    state.machines = [LOCAL, { ...BUILD, status: "offline" }];
    const before = counts();
    await fleet.refresh();
    expect(stream.stopped).toBe(true);
    expect(fleet.count).toBe(0);
    expect(counts()).toBe(before + 1);
    expect(fleet.localNoticeMachine()).toBeUndefined();
    // A late event from the old stream changes nothing.
    stream.handlers.onEvent(changed(run("r9", "running")));
    expect(fleet.count).toBe(0);

    // Back online, it gets a fresh stream and list.
    state.machines = [LOCAL, BUILD];
    await fleet.refresh();
    await settle();
    expect(streams.get("m1")).not.toBe(stream);
    expect(fleet.count).toBe(1);

    state.machines = [LOCAL, { ...BUILD, status: "revoked" }];
    await fleet.refresh();
    expect(fleet.count).toBe(0);
    expect(fleet.machineIds).toEqual([]);
  });

  it("keeps the machines it follows while the machine list fails", async () => {
    const { fleet, state, intervals } = setup([LOCAL, BUILD], { m1: [run("r1", "running")] });
    fleet.start();
    await settle();
    expect(fleet.count).toBe(1);
    state.machines = new Error("The server is restarting.");
    await fleet.refresh();
    expect(fleet.machineIds).toEqual(["m1"]);
    expect(intervals[0]!.cleared).toBe(false);
    fleet.stop();
    expect(intervals[0]!.cleared).toBe(true);
    expect(fleet.machineIds).toEqual([]);
  });

  it("stops polling a server without machine routes", async () => {
    const { fleet, intervals, streams } = setup(
      Object.assign(new Error("Not found."), { status: 404 }),
      {},
    );
    fleet.start();
    await settle();
    expect(intervals[0]!.cleared).toBe(true);
    expect(streams.size).toBe(0);
  });
});

describe("tray", () => {
  it("describes the count", () => {
    expect(trayTooltip(0)).toMatch(/no active runs/);
    expect(trayTooltip(1)).toMatch(/1 active run$/);
    expect(trayTooltip(3)).toMatch(/3 active runs/);
  });

  it("draws a ring when idle and a filled badge with digits when busy", () => {
    const px = (buf: Buffer, x: number, y: number) => [
      ...buf.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4),
    ];
    const idle = trayBitmap(0);
    const busy = trayBitmap(12);
    expect(idle).toHaveLength(32 * 32 * 4);
    expect(px(idle, 16, 16)[3]).toBe(0);
    expect(px(idle, 16, 1)[3]).toBe(255);
    const white = [...Array(32 * 32).keys()].filter(
      (i) => busy[i * 4] === 255 && busy[i * 4 + 1] === 255,
    );
    expect(white.length).toBeGreaterThan(10);
  });
});

describe("loading the page", () => {
  const page = "https://127.0.0.1:21400/review/";
  const isApp = (url: string) => url.startsWith(page);
  const failed = (url: string, errorCode = -102, isMainFrame = true) => ({
    url,
    errorCode,
    isMainFrame,
  });

  it("notices when the server's page fails to load", () => {
    expect(lostAppPage(failed(page), "", isApp)).toBe(true);
    expect(lostAppPage(failed(`${page}?box=b#/launch`), page, isApp)).toBe(true);
  });

  it("ignores frames, other pages, and a cancelled load over the app", () => {
    expect(lostAppPage(failed(page, -102, false), page, isApp)).toBe(false);
    expect(lostAppPage(failed("https://example.com/"), page, isApp)).toBe(false);
    expect(lostAppPage(failed(page, ERR_ABORTED), page, isApp)).toBe(false);
    expect(lostAppPage(failed(page, ERR_ABORTED), "", isApp)).toBe(true);
  });

  it("says the server isn't reachable on a page of its own", () => {
    const url = offlinePageUrl("https://127.0.0.1:21400");
    expect(url.startsWith("data:text/html")).toBe(true);
    expect(decodeURIComponent(url)).toContain("isn't reachable");
    expect(isApp(url)).toBe(false);
  });
});

describe("PendingNavigation", () => {
  it("sends at once when the page can take it", () => {
    const p = new PendingNavigation();
    expect(p.request("#/runs", true)).toBe("#/runs");
    expect(p.take()).toBeNull();
  });

  it("keeps the newest route until the page loads, and gives it once", () => {
    const p = new PendingNavigation();
    expect(p.request("#/runs", false)).toBeNull();
    expect(p.request("#/dashboard", false)).toBeNull();
    expect(p.take()).toBe("#/dashboard");
    expect(p.take()).toBeNull();
  });
});
