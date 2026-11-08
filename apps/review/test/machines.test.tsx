// Review runs across machines: the fleet store, the machine picker, and the
// all-machines run table, against one fake server per machine behind a fake
// hub.
import { DEFAULT_POLICY, RUN_CONCURRENCY_CAPABILITY, type RunState } from "@aio/contracts";
import { FakeServer, makeBoxView } from "@aio/ui/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { App } from "../src/App.js";
import { EMPTY_REFS } from "../src/lib/repos.js";
import { FleetProvider } from "../src/components/machines.js";
import { fleetRuns, MachineFleet, mergeRuns, SHOW_OFFLINE_RUNS_KEY } from "../src/state/fleet.js";
import { Launcher } from "../src/screens/Launcher.js";
import { AppStore, StoreProvider } from "../src/state/store.js";
import { lastRun, loadDemoEvents, project } from "./helpers/data.js";
import { fakeHub, machine, MACHINE_LIST } from "./helpers/hub.js";

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

/** A promise for `FakeHub.held`, and the function that releases it. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

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

describe("the launcher on another machine", () => {
  it("sends the role, tier, and cross-vendor controls to the selected machine", async () => {
    const { local, build, fleet } = setup();
    build.on("projects.list", () => ({ projects: [project] }));
    build.on("projects.repos.list", () => ({
      repos: [
        {
          path: "/srv/src/build-app",
          name: "build-app",
          currentBranch: "topic",
          headSha: null,
          dirty: false,
        },
      ],
    }));
    build.on("projects.repos.refs", () => EMPTY_REFS);
    build.on("runs.create", () => remoteRun());
    fleet.select("m1");
    render(
      <StoreProvider store={fleet.storeFor("m1")}>
        <Launcher prefill={{ project: project.project.id, box: null }} />
      </StoreProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue("/srv/src/build-app"),
    );
    fireEvent.change(screen.getByLabelText(/^Tier/), { target: { value: "large" } });
    fireEvent.click(screen.getByLabelText("Cross-vendor checks"));
    const table = screen.getByRole("table", { name: "Roles" });
    fireEvent.click(within(table).getByRole("radio", { name: "fixer: Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(build.callsTo("runs.create")).toHaveLength(1));
    expect(build.callsTo("runs.create")[0]!.body).toMatchObject({
      repoPath: "/srv/src/build-app",
      roles: { fixer: "codex" },
      modelTier: "large",
      crossVendor: false,
    });
    expect(local.callsTo("runs.create")).toHaveLength(0);
  });
});

describe("parallel calls on another machine", () => {
  async function startWithParallelCalls(capabilities: string[]) {
    const { build, fleet } = setup([LOCAL, { ...BUILD, capabilities }]);
    build.on("projects.list", () => ({ projects: [project] }));
    build.on("projects.repos.list", () => ({
      repos: [
        {
          path: "/srv/src/build-app",
          name: "build-app",
          currentBranch: "topic",
          headSha: null,
          dirty: false,
        },
      ],
    }));
    build.on("projects.repos.refs", () => EMPTY_REFS);
    build.on("runs.create", () => remoteRun());
    await fleet.refresh();
    fleet.select("m1");
    render(
      <FleetProvider fleet={fleet}>
        <StoreProvider store={fleet.storeFor("m1")}>
          <Launcher prefill={{ project: project.project.id, box: null }} />
        </StoreProvider>
      </FleetProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue("/srv/src/build-app"),
    );
    fireEvent.change(screen.getByLabelText(/^Parallel calls/), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    return build;
  }

  it("refuses the setting for a server that would drop it", async () => {
    const build = await startWithParallelCalls([]);
    await screen.findByText(/too old to set parallel calls/);
    expect(build.callsTo("runs.create")).toHaveLength(0);
  });

  it("sends the setting to a server that lists the capability", async () => {
    const build = await startWithParallelCalls([RUN_CONCURRENCY_CAPABILITY]);
    await waitFor(() => expect(build.callsTo("runs.create")).toHaveLength(1));
    expect(build.callsTo("runs.create")[0]!.body).toMatchObject({ concurrency: 1 });
  });
});

describe("the usage view on another machine", () => {
  it("loads the selected machine's windows through its store", async () => {
    const { build, fleet } = setup();
    const store = fleet.storeFor("m1");
    await store.loadUsage();
    expect(build.callsTo("usage.get").length).toBeGreaterThan(0);
    expect(store.getState().usageInfo).toEqual([]);
  });
});

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

  describe("when answers take longer than a poll", () => {
    const TIMEOUT = { status: 504, code: "machine_timeout", message: "No answer in time." };
    const entry = (fleet: MachineFleet, id: string) =>
      fleet.getState().machines.find((m) => m.machine.id === id)!;

    it("applies the other machines' runs while one machine stalls across polls", async () => {
      const { hub, fleet } = setup();
      const hung = gate();
      hub.held.m1 = hung.promise;
      const polls = [fleet.refresh()];
      await waitFor(() => expect(entry(fleet, "local").reach).toBe("online"));
      expect(entry(fleet, "local").runs.map((r) => r.id)).toEqual([lastRun().id]);
      expect(entry(fleet, "m1").reach).toBe("loading");

      // Later polls supersede nothing: the stalled call still reports its failure.
      polls.push(fleet.refresh(), fleet.refresh());
      hub.failing.m1 = TIMEOUT;
      hung.release();
      await Promise.all(polls);
      expect(entry(fleet, "m1")).toMatchObject({ reach: "offline", error: TIMEOUT.message });
      expect(entry(fleet, "local").reach).toBe("online");
    });

    it("applies a slow machine's runs when a later poll is under way", async () => {
      const { hub, fleet } = setup();
      const calls = () =>
        hub.paths.filter((p) => p === "GET /api/v1/machines/m1/proxy/runs").length;
      const [slow, slower] = [gate(), gate()];
      hub.held.m1 = slow.promise;
      const first = fleet.refresh();
      await waitFor(() => expect(calls()).toBe(1));
      hub.held.m1 = slower.promise;
      const second = fleet.refresh();
      await waitFor(() => expect(calls()).toBe(2));
      slow.release();
      await first;
      expect(entry(fleet, "m1").reach).toBe("online");
      expect(entry(fleet, "m1").runs.map((r) => r.id)).toEqual([REMOTE_RUN_ID]);
      slower.release();
      await second;
    });

    it("ignores an older answer that arrives after a newer one", async () => {
      const { hub, fleet } = setup();
      const slow = gate();
      hub.held.m1 = slow.promise;
      const first = fleet.refresh();
      await waitFor(() => expect(hub.paths).toContain("GET /api/v1/machines/m1/proxy/runs"));
      delete hub.held.m1;
      hub.failing.m1 = TIMEOUT;
      await fleet.refresh();
      expect(entry(fleet, "m1").reach).toBe("offline");

      delete hub.failing.m1;
      slow.release();
      await first;
      expect(entry(fleet, "m1").reach).toBe("offline");
    });

    it("applies no answer after the fleet stops", async () => {
      const { hub, fleet } = setup();
      const slow = gate();
      hub.held.m1 = slow.promise;
      const first = fleet.refresh();
      await waitFor(() => expect(entry(fleet, "m1")?.reach).toBe("loading"));
      fleet.stop();
      slow.release();
      await first;
      expect(entry(fleet, "m1").reach).toBe("loading");
    });

    it("reports a hung machine list even though later polls started", async () => {
      const { hub, fleet } = setup();
      const [hung, later] = [gate(), gate()];
      hub.held[MACHINE_LIST] = hung.promise;
      const first = fleet.refresh();
      hub.held[MACHINE_LIST] = later.promise;
      const second = fleet.refresh();
      hub.failing[MACHINE_LIST] = { status: 500, code: "internal", message: "List failed." };
      hung.release();
      await first;
      expect(fleet.getState()).toMatchObject({ supported: null, error: "List failed." });
      later.release();
      await second;
    });
  });

  describe("when the machine list fails", () => {
    it.each([
      [503, "hub_unreachable", "offline"],
      [401, "unauthorized", "error"],
    ])("hides the last runs after a %i %s answer", async (status, code, reach) => {
      const { hub, fleet } = setup();
      await fleet.refresh();
      hub.failing[MACHINE_LIST] = { status, code, message: "No list." };
      await fleet.refresh();
      const s = fleet.getState();
      expect(s.error).toBe("No list.");
      expect(s.machines.map((m) => m.reach)).toEqual([reach, reach, reach]);
      expect(fleetRuns(s)).toEqual([]);

      // The last runs and their times stay for a viewer who asks for them.
      fleet.setShowOfflineRuns(true);
      expect(fleetRuns(fleet.getState())).toHaveLength(2);
      expect(fleet.getState().machines[0]!.loadedAt).not.toBeNull();

      // The next good list brings them back whatever the choice.
      fleet.setShowOfflineRuns(false);
      delete hub.failing[MACHINE_LIST];
      await fleet.refresh();
      expect(fleet.getState().error).toBeNull();
      expect(fleet.getState().machines.map((m) => m.reach)).toEqual([
        "online",
        "online",
        "offline",
      ]);
      expect(fleetRuns(fleet.getState())).toHaveLength(2);
    });
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
    const toggle = within(table).getByRole("checkbox", {
      name: "Show offline machines' last runs",
    });
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
    // The link names the machine, so a new tab or a reload finds the run.
    expect(link).toHaveAttribute("href", `#/runs/${REMOTE_RUN_ID}?machine=m1`);
    const localLink = within(table).getByRole("link", { name: lastRun().id.slice(-6) });
    expect(localLink).toHaveAttribute("href", `#/runs/${lastRun().id}`);
    fireEvent.click(link);
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${REMOTE_RUN_ID}?machine=m1`));
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

  it("restores a remote run's machine when its link loads in a new page", async () => {
    const { store, fleet, hub } = setup();
    store.start();
    fleet.start();
    go(`#/runs/${REMOTE_RUN_ID}?machine=m1`);
    renderApp(fleet, store);
    expect(fleet.getState().selected).toBe("m1");
    await waitFor(() =>
      expect(hub.paths).toContain(`GET /api/v1/machines/m1/proxy/runs/${REMOTE_RUN_ID}`),
    );
    expect(hub.paths).not.toContain(`GET /api/v1/runs/${REMOTE_RUN_ID}`);
  });

  it.each([
    ["unknown", "ghost"],
    ["revoked", "m3"],
  ])("stays on this machine when a link names a machine that is %s", async (_kind, id) => {
    const { store, fleet, hub } = setup();
    store.start();
    go(`#/runs?machine=${id}`);
    renderApp(fleet, store);
    expect(fleet.getState().selected).toBe(id);
    await act(() => fleet.refresh());
    expect(fleet.getState().selected).toBe("local");

    // Later polls change nothing: the screens stay mounted and no store returns.
    const nav = screen.getByRole("link", { name: /^Runs/ });
    const sockets = hub.socketPaths.length;
    await act(() => fleet.refresh());
    await act(() => fleet.refresh());
    expect(fleet.getState().selected).toBe("local");
    expect(screen.getByRole("link", { name: /^Runs/ })).toBe(nav);
    expect(hub.socketPaths.length).toBe(sockets);
  });

  it("drops a linked machine for good on a server without machine routes", async () => {
    const { store, fleet } = setup("unsupported" as never);
    store.start();
    go("#/launch?machine=m1");
    renderApp(fleet, store);
    expect(fleet.getState().selected).toBe("m1");
    const linkedStore = fleet.storeFor("m1");
    await act(() => fleet.refresh());
    await waitFor(() => expect(fleet.getState().selected).toBe("local"));
    expect(linkedStore.getState().connection).toBe("closed");
    expect(screen.queryByRole("combobox", { name: "Machine" })).not.toBeInTheDocument();
    act(() => fleet.select("m1"));
    expect(fleet.getState().selected).toBe("local");
  });

  describe("with unsaved policy edits", () => {
    function dirtyPolicy(hash: string) {
      const { store, fleet, local } = setup();
      local.on("projects.list", () => ({ projects: [project] }));
      local.on("projects.policy.get", () => ({
        path: "/home/user/src/example-app/.aio/policy.yaml",
        exists: true,
        policy: DEFAULT_POLICY,
      }));
      store.start();
      fleet.start();
      go(hash);
      renderApp(fleet, store);
      return { fleet };
    }

    async function edit(): Promise<HTMLElement> {
      await screen.findByRole("combobox", { name: "Machine" });
      const risk = await screen.findByLabelText(/^Risk paths/);
      await waitFor(() => expect(risk).toBeEnabled());
      fireEvent.change(risk, { target: { value: "src/edited/**" } });
      return risk;
    }

    const url = `#/policy?project=${project.project.id}`;
    let confirm: MockInstance<(message?: string) => boolean>;
    beforeEach(() => {
      confirm = vi.spyOn(window, "confirm");
    });
    afterEach(() => {
      confirm.mockRestore();
      vi.unstubAllGlobals();
    });

    it("keeps the edits when the viewer refuses a switch in the picker", async () => {
      const { fleet } = dirtyPolicy("#/policy");
      await edit();
      confirm.mockReturnValue(false);
      fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
        target: { value: "m1" },
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(fleet.getState().selected).toBe("local");
      expect(screen.getByRole("combobox", { name: "Machine" })).toHaveValue("local");
      expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("src/edited/**");
    });

    it("switches once the viewer agrees in the picker, with one prompt", async () => {
      const { fleet } = dirtyPolicy(url);
      await edit();
      confirm.mockReturnValue(true);
      fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), {
        target: { value: "m1" },
      });
      expect(fleet.getState().selected).toBe("m1");
      await waitFor(() => expect(window.location.hash).toBe("#/policy"));
      await act(() => new Promise((r) => setTimeout(r, 0)));
      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("asks before a delivered link switches machines", async () => {
      let deliver: (hash: string) => void = () => undefined;
      vi.stubGlobal("aio", {
        takeToken: () => null,
        serverUrl: null,
        onNavigate: (fn: (hash: string) => void) => {
          deliver = fn;
          return () => undefined;
        },
      });
      const { fleet } = dirtyPolicy(url);
      await edit();
      confirm.mockReturnValue(false);
      act(() => deliver("#/launch?machine=m1"));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(fleet.getState().selected).toBe("local");
      expect(window.location.hash).toBe(url);
      expect(screen.getByLabelText(/^Risk paths/)).toHaveValue("src/edited/**");

      confirm.mockReturnValue(true);
      act(() => deliver("#/launch?machine=m1"));
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(fleet.getState().selected).toBe("m1");
      await act(() => new Promise((r) => setTimeout(r, 0)));
      expect(confirm).toHaveBeenCalledTimes(2);
    });
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
