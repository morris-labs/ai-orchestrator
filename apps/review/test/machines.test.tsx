// Review runs across machines: the fleet store, the machine picker, and the
// all-machines run table, against one fake server per machine behind a fake
// hub.
import type { RunState } from "@aio/contracts";
import { FakeServer, makeBoxView } from "@aio/ui/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { FleetProvider } from "../src/components/machines.js";
import {
  fleetRuns,
  MachineFleet,
  mergeRuns,
  SHOW_OFFLINE_RUNS_KEY,
} from "../src/state/fleet.js";
import { AppStore, StoreProvider } from "../src/state/store.js";
import { lastRun, loadDemoEvents, project } from "./helpers/data.js";
import { fakeHub, machine } from "./helpers/hub.js";

const LOCAL = machine({ id: "local", name: "main-pc", role: "both", isLocal: true });
const BUILD = machine({ id: "m1", name: "build-server" });
const LAPTOP = machine({ id: "m2", name: "laptop", status: "offline" });
const OLD = machine({ id: "m3", name: "old-pc", status: "revoked" });

const REMOTE_RUN_ID = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";

function remoteRun(over: Partial<RunState> = {}): RunState {
  return {
    ...lastRun(),
    id: REMOTE_RUN_ID,
    status: "running",
    updatedAt: "2026-12-01T00:00:00.000Z",
    request: { ...lastRun().request, repoPath: "/srv/src/build-app" },
    ...over,
  };
}

/** A fake server for one machine, with the routes the app's screens call. */
function server(runs: RunState[]): FakeServer {
  const s = new FakeServer({ projects: [project.project] });
  s.on("runs.list", () => ({ runs }));
  s.on("runs.get", (req) => runs.find((r) => r.id === req.params.runId) ?? runs[0]!);
  s.on("runs.rounds", () => ({ rounds: [] }));
  s.on("findings.list", () => ({ findings: [] }));
  s.on("usage.get", () => ({ vendors: [] }));
  s.on("usage.samples", () => ({ samples: [] }));
  s.on("stats.refresh", () => ({ ok: true as const }));
  return s;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  window.location.hash = "";
  localStorage.clear();
});

function setup(machines = [LOCAL, BUILD, LAPTOP, OLD]) {
  const local = server([lastRun()]);
  const build = server([remoteRun()]);
  const hub = fakeHub({ local, servers: { m1: build }, machines });
  const store = new AppStore(hub.client);
  const fleet = new MachineFleet(store, hub.makeClient, 60_000);
  cleanups.push(() => {
    fleet.stop();
    store.stop();
  });
  return { local, build, hub, store, fleet };
}

describe("the machine fleet", () => {
  it("lists every shown machine's runs and leaves out revoked machines", async () => {
    const { hub, fleet } = setup();
    await fleet.refresh();
    const s = fleet.getState();
    expect(s.supported).toBe(true);
    expect(s.machines.map((m) => [m.machine.name, m.reach])).toEqual([
      ["main-pc", "online"],
      ["build-server", "online"],
      ["laptop", "offline"],
    ]);
    // No call goes to the machine the hub reports offline, or to a revoked one.
    expect(hub.paths).not.toContain("GET /api/v1/machines/m2/proxy/runs");
    expect(hub.paths).not.toContain("GET /api/v1/machines/m3/proxy/runs");
    expect(hub.paths).toContain("GET /api/v1/machines/m1/proxy/runs");
    expect(fleetRuns(s).map((r) => [r.machineName, r.run.id])).toEqual([
      ["build-server", REMOTE_RUN_ID],
      ["main-pc", lastRun().id],
    ]);
  });

  it("marks a machine offline when it stops answering and hides its last runs", async () => {
    const { hub, fleet } = setup();
    await fleet.refresh();
    hub.failing.m1 = { status: 504, code: "machine_timeout", message: "No answer in time." };
    await fleet.refresh();
    const build = fleet.getState().machines.find((m) => m.machine.id === "m1")!;
    expect(build.reach).toBe("offline");
    expect(build.error).toBe("No answer in time.");
    // The fleet keeps the last runs, but by default shows none of them.
    expect(fleet.getState().showOfflineRuns).toBe(false);
    expect(build.runs.map((r) => r.id)).toEqual([REMOTE_RUN_ID]);
    expect(fleetRuns(fleet.getState()).map((r) => r.machineName)).toEqual(["main-pc"]);
    // The other machines still list.
    expect(fleet.getState().machines[0]!.reach).toBe("online");

    // With the viewer's choice on, the last runs show, marked offline.
    fleet.setShowOfflineRuns(true);
    expect(fleetRuns(fleet.getState()).map((r) => [r.machineName, r.reach])).toEqual([
      ["build-server", "offline"],
      ["main-pc", "online"],
    ]);

    // Back online, its runs show whatever the choice.
    fleet.setShowOfflineRuns(false);
    delete hub.failing.m1;
    await fleet.refresh();
    expect(fleetRuns(fleet.getState()).map((r) => [r.machineName, r.reach])).toEqual([
      ["build-server", "online"],
      ["main-pc", "online"],
    ]);
  });

  it("keeps the viewer's choice to show offline machines' last runs", () => {
    const { store, hub, fleet } = setup();
    expect(fleet.getState().showOfflineRuns).toBe(false);
    fleet.setShowOfflineRuns(true);
    expect(localStorage.getItem(SHOW_OFFLINE_RUNS_KEY)).toBe("true");
    const again = new MachineFleet(store, hub.makeClient, 60_000);
    expect(again.getState().showOfflineRuns).toBe(true);
    again.setShowOfflineRuns(false);
    expect(new MachineFleet(store, hub.makeClient, 60_000).getState().showOfflineRuns).toBe(false);
    // Without storage, the choice lasts only as long as the fleet.
    const memory = new MachineFleet(store, hub.makeClient, 60_000, Date.now, null);
    memory.setShowOfflineRuns(true);
    expect(memory.getState().showOfflineRuns).toBe(true);
    expect(localStorage.getItem(SHOW_OFFLINE_RUNS_KEY)).toBe("false");
  });

  it("shows one machine on a server without machine routes", async () => {
    const { hub, fleet } = setup("unsupported" as never);
    expect(fleet.getState().supported).toBeNull();
    await fleet.refresh();
    expect(fleet.getState()).toMatchObject({ supported: false, machines: [], selected: "local" });
    expect(hub.paths).toEqual(["GET /api/v1/machines"]);
  });

  it("selects local again when the selected machine is revoked", async () => {
    const { hub, fleet } = setup();
    await fleet.refresh();
    fleet.select("m1");
    expect(fleet.getState().selected).toBe("m1");
    const old = fleet.storeFor("m1");
    hub.machines = [LOCAL, { ...BUILD, status: "revoked" }];
    await fleet.refresh();
    expect(fleet.getState().selected).toBe("local");
    // The revoked machine's store stops, and a later select makes a new one.
    expect(old.getState().connection).toBe("closed");
    expect(fleet.storeFor("m1")).not.toBe(old);
  });

  it("follows a selected machine's run changes over its event stream", async () => {
    const { build, hub, fleet } = setup();
    await fleet.refresh();
    fleet.select("m1");
    await waitFor(() => expect(hub.socketPaths).toContain("/api/v1/machines/m1/proxy/events"));
    await waitFor(() => expect(fleet.storeFor("m1").getState().connection).toBe("open"));
    expect(build.socketsFor("/api/v1/events")).toHaveLength(1);
    const template = loadDemoEvents().find((e) => e.type === "run.changed")!;
    build.emit({
      ...template,
      run: remoteRun({ status: "finished", updatedAt: "2026-12-01T00:01:00.000Z" }),
    } as never);
    await waitFor(() =>
      expect(fleet.getState().machines.find((m) => m.machine.id === "m1")!.runs[0]!.status).toBe(
        "finished",
      ),
    );
  });

  it("merges a list with newer runs from events", () => {
    const listed = [remoteRun({ updatedAt: "2026-12-01T00:00:00.000Z" })];
    const newer = remoteRun({ status: "finished", updatedAt: "2026-12-01T00:05:00.000Z" });
    const created = {
      ...lastRun(),
      id: "01JB8Z5K3W6Q2V9X4T7R0M1N2R",
      updatedAt: "2026-12-01T00:06:00.000Z",
    };
    const gone = {
      ...lastRun(),
      id: "01JB8Z5K3W6Q2V9X4T7R0M1N2S",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const merged = mergeRuns(listed, [newer, created, gone], "2026-12-01T00:02:00.000Z");
    expect(merged.map((r) => [r.id, r.status])).toEqual([
      [created.id, created.status],
      [REMOTE_RUN_ID, "finished"],
    ]);
  });
});

function renderApp(fleet: MachineFleet, store: AppStore, search = "") {
  return render(
    <StoreProvider store={store}>
      <FleetProvider fleet={fleet}>
        <App search={search} />
      </FleetProvider>
    </StoreProvider>,
  );
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

describe("the Review app on several machines", () => {
  it("shows every machine's runs on the dashboard, with the offline one named", async () => {
    const { store, fleet, hub } = setup();
    hub.failing.m1 = { status: 504, code: "machine_timeout", message: "No answer in time." };
    store.start();
    fleet.start();
    go("#/dashboard");
    renderApp(fleet, store);
    const table = await screen.findByRole("region", { name: "Runs on every machine" });
    await waitFor(() => expect(within(table).getByText("laptop: Offline")).toBeInTheDocument());
    expect(within(table).getByText("build-server: Offline")).toBeInTheDocument();
    // This machine's run still shows: one machine down never empties the view.
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("main-pc");
    expect(rows[1]).toHaveTextContent(lastRun().id.slice(-6));
    expect(screen.getByRole("heading", { name: "On main-pc" })).toBeInTheDocument();
  });

  it("shows an offline machine's last runs with their time only when the viewer asks", async () => {
    const { store, fleet, hub } = setup();
    store.start();
    fleet.start();
    go("#/dashboard");
    renderApp(fleet, store);
    const table = await screen.findByRole("region", { name: "Runs on every machine" });
    await within(table).findByRole("link", { name: REMOTE_RUN_ID.slice(-6) });

    // build-server goes offline: by default it shows as offline with no runs.
    hub.failing.m1 = { status: 504, code: "machine_timeout", message: "No answer in time." };
    await act(() => fleet.refresh());
    expect(within(table).getByText("build-server: Offline")).toBeInTheDocument();
    expect(within(table).queryByRole("link", { name: REMOTE_RUN_ID.slice(-6) })).toBeNull();
    expect(within(table).queryByText(/as of/)).toBeNull();
    const toggle = within(table).getByRole("checkbox", { name: "Show offline machines' last runs" });
    expect(toggle).not.toBeChecked();

    // Turned on, its last runs show, named offline, with the time they were listed.
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    const link = within(table).getByRole("link", { name: REMOTE_RUN_ID.slice(-6) });
    expect(link.closest("tr")).toHaveTextContent("build-server (offline)");
    expect(within(table).getByText(/Its runs are as of/)).toBeInTheDocument();
    expect(localStorage.getItem(SHOW_OFFLINE_RUNS_KEY)).toBe("true");

    // Turned off again, they go.
    fireEvent.click(toggle);
    expect(within(table).queryByRole("link", { name: REMOTE_RUN_ID.slice(-6) })).toBeNull();
  });

  it("opens another machine's run from the dashboard and reads it through the hub", async () => {
    const { store, fleet, hub } = setup();
    store.start();
    fleet.start();
    go("#/dashboard");
    renderApp(fleet, store);
    const table = await screen.findByRole("region", { name: "Runs on every machine" });
    const link = await within(table).findByRole("link", { name: REMOTE_RUN_ID.slice(-6) });
    const row = link.closest("tr")!;
    expect(row).toHaveTextContent("build-server");
    expect(row).toHaveTextContent("/srv/src/build-app");
    fireEvent.click(link);
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${REMOTE_RUN_ID}`));
    expect(fleet.getState().selected).toBe("m1");
    await waitFor(() =>
      expect(hub.paths).toContain(`GET /api/v1/machines/m1/proxy/runs/${REMOTE_RUN_ID}`),
    );
    expect(await screen.findByText("/srv/src/build-app", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Machine" })).toHaveValue("m1");
  });

  it("switches machines with the picker and lists that machine's runs", async () => {
    const { store, fleet, hub } = setup();
    store.start();
    fleet.start();
    go("#/runs");
    renderApp(fleet, store);
    const picker = await screen.findByRole("combobox", { name: "Machine" });
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["main-pc (this PC)", "build-server", "laptop (offline)"]);
    fireEvent.change(picker, { target: { value: "m1" } });
    await waitFor(() => expect(hub.paths).toContain("GET /api/v1/machines/m1/proxy/runs"));
    expect(await screen.findByRole("link", { name: REMOTE_RUN_ID.slice(-6) })).toBeInTheDocument();

    // A run belongs to one machine: switching away from its view goes to the list.
    go(`#/runs/${REMOTE_RUN_ID}`);
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
      target: { value: "local" },
    });
    await waitFor(() => expect(window.location.hash).toBe("#/runs"));
  });

  it("starts a run on the selected machine", async () => {
    const { store, fleet, hub, build } = setup();
    build.on("runs.create", () => remoteRun({ status: "pending" }));
    store.start();
    fleet.start();
    await fleet.refresh();
    fleet.select("m1");
    const api = fleet.storeFor("m1").api;
    await api.call("runs.create", {
      body: {
        projectId: project.project.id,
        repoPath: "/srv/src/build-app",
        base: "origin/main",
      } as never,
    });
    expect(hub.paths).toContain("POST /api/v1/machines/m1/proxy/runs");
    expect(build.callsTo("runs.create")).toHaveLength(1);
  });

  it("opens the launcher on the machine a deep link names", async () => {
    const { store, fleet, hub, build } = setup();
    const box = makeBoxView({
      box: { id: "aio-agent-build", projectId: project.project.id, targetDir: "/srv/build" },
      status: "running",
    });
    build.on("boxes.get", () => box);
    store.start();
    fleet.start();
    window.history.replaceState(null, "", "/review/#/launch");
    renderApp(fleet, store, `?project=${project.project.id}&box=aio-agent-build&machine=m1`);
    expect(window.location.hash).toBe(
      `#/launch?project=${project.project.id}&box=aio-agent-build&machine=m1`,
    );
    expect(fleet.getState().selected).toBe("m1");
    await waitFor(() =>
      expect(hub.paths).toContain("GET /api/v1/machines/m1/proxy/boxes/aio-agent-build"),
    );
    // This machine never hears of the other machine's box.
    expect(hub.paths).not.toContain("GET /api/v1/boxes/aio-agent-build");
  });

  it("looks like a single machine without machine routes", async () => {
    const { store, fleet } = setup("unsupported" as never);
    store.start();
    fleet.start();
    go("#/dashboard");
    renderApp(fleet, store);
    expect(await screen.findByRole("heading", { name: "Infrastructure" })).toBeInTheDocument();
    await waitFor(() => expect(fleet.getState().supported).toBe(false));
    expect(screen.queryByRole("combobox", { name: "Machine" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Runs on every machine" })).not.toBeInTheDocument();
  });
});
