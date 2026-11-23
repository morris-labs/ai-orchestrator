import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { demoBox, demoRounds, lastRun, loadDemoEvents, project, settings } from "./helpers/data.js";
import { renderWithStore } from "./helpers/render.js";

const events = loadDemoEvents();

function handlers() {
  return {
    "projects.list": () => ({ projects: [project] }),
    "runs.list": () => ({ runs: [lastRun()] }),
    "runs.get": () => lastRun(),
    "runs.rounds": () => ({ rounds: demoRounds() }),
    "findings.list": () => ({ findings: [] }),
    "findings.get": () => {
      throw new Error("not used");
    },
    "usage.get": () => ({
      vendors: [
        {
          vendor: "claude",
          account: "user@example.com",
          ceiling: settings.ceilings.claude,
          latest: [],
          overCeiling: false,
          forecastAt: null,
          resetAt: "2026-10-28T13:00:00.000Z",
          window: "5h",
        },
      ],
    }),
    "usage.samples": () => ({ samples: [] }),
    "stats.refresh": () => ({ ok: true }),
    "settings.get": () => settings,
  };
}

describe("App with the scripted event stream", () => {
  it("refreshes upgrade notices and machine status when the server reconnects", async () => {
    const { store, server } = renderWithStore(<App search="" />, handlers());
    server.state.updates.claudeCode = { latest: "3.0.0", image: "2.0.0", stale: true };
    store.start();
    await screen.findByText(/Claude Code 3.0.0 is available/);
    const before = server.callsTo("machines.list").length;
    server.state.updates.claudeCode.stale = false;
    server.state.image.upgrading = true;
    server.state.image.buildLogJobId = "upgrade-job";
    act(() => server.socketsFor("/api/v1/events")[0]!.close());
    await screen.findByText("Upgrading: building the image");
    await waitFor(() => expect(screen.queryByText(/Claude Code 3.0.0 is available/)).toBeNull());
    expect(screen.getByRole("link", { name: "Build log" })).toBeInTheDocument();
    expect(server.callsTo("machines.list").length).toBeGreaterThan(before);
    store.stop();
  });

  it("shows the unread usage watcher alerts", async () => {
    const { store, server } = renderWithStore(<App search="" />, handlers());
    server.state.notifications = [
      {
        notificationId: "usage-1",
        kind: "usage_alert",
        title: "Build settings-page passed 2 times its usage estimate",
        body: "The build used 2,100 tokens against an estimate of 500 to 1,000.",
        runId: null,
        boxId: "aio-agent-site",
        buildId: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q",
        severity: "warning",
        read: false,
      },
    ];
    store.start();

    const region = await screen.findByRole("region", { name: "Usage alerts" });
    expect(
      within(region).getByText("Build settings-page passed 2 times its usage estimate"),
    ).toBeInTheDocument();
    store.stop();
  });

  it("replays the demo into the dashboard and the navigation", async () => {
    const { store, server } = renderWithStore(<App search="" />, handlers());
    store.start();
    const [ws] = server.socketsFor("/api/v1/events");
    expect(ws!.url).toBe("ws://localhost:3000/api/v1/events");
    expect(await screen.findByText("● Live")).toBeInTheDocument();
    await waitFor(() => expect(server.callsTo("stats.refresh")).toHaveLength(1));
    act(() => {
      for (const e of events) server.emit(e);
    });

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByLabelText("1 need a decision")).toBeInTheDocument();

    act(() => {
      window.location.hash = "#/dashboard";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByRole("heading", { name: "Infrastructure" })).toBeInTheDocument();
    expect(screen.getByText(`${events.length} events`)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Fleet" })).toHaveTextContent("Connected");

    fireEvent.click(
      within(screen.getByRole("region", { name: "Fleet" })).getByRole("button", {
        name: lastRun().id.slice(-6),
      }),
    );
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${lastRun().id}`));
    store.stop();
  });

  it("loads state through REST on the first hello and after a resync", async () => {
    const { store, server } = renderWithStore(<App search="" />, handlers());
    store.start();
    const nav = screen.getByRole("navigation", { name: "Main" });
    // No event says so: the badge comes from runs.list.
    expect(await within(nav).findByLabelText("1 need a decision")).toBeInTheDocument();
    expect(server.callsTo("findings.list")).toHaveLength(1);

    // The server restarted and the run finished meanwhile.
    server.on("runs.list", () => ({ runs: [{ ...lastRun(), status: "finished" as const }] }));
    const [ws] = server.socketsFor("/api/v1/events");
    act(() => {
      ws!.serverSend({ type: "hello", streamId: "restarted", lastSeq: 0, replaying: false });
    });
    await waitFor(() =>
      expect(within(nav).queryByLabelText("1 need a decision")).not.toBeInTheDocument(),
    );
    expect(store.getState().dashboard.runs[lastRun().id]?.run?.status).toBe("finished");
    store.stop();
  });

  it("opens the launcher prefilled from the deep link", async () => {
    renderWithStore(<App search={`?project=${project.project.id}`} />, handlers());
    await waitFor(() => expect(screen.getByLabelText("Container")).toHaveValue(project.project.id));
  });

  it("applies the deep link once, not to every later launcher", async () => {
    const box = demoBox();
    const { server } = renderWithStore(<App search={`?box=${box.id}`} />, {
      ...handlers(),
      "boxes.get": () => ({
        box,
        status: "running",
        container: box.container,
        tmuxSession: box.session,
        reviewState: { state: "idle" },
        stats: null,
        listeners: [],
        proxyUrls: [],
        sideSessions: [],
        targetDirExists: true,
      }),
    });
    await waitFor(() => expect(server.callsTo("boxes.get")).toHaveLength(1));
    expect(window.location.hash).toBe(`#/launch?box=${box.id}`);
    act(() => {
      window.location.hash = "#/runs";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    act(() => {
      window.location.hash = "#/launch";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await screen.findByLabelText("Container");
    await new Promise((res) => setTimeout(res, 20));
    expect(server.callsTo("boxes.get")).toHaveLength(1);
  });
});
