import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { demoRounds, lastRun, project, settings } from "./helpers/data.js";
import { renderWithStore } from "./helpers/render.js";
import { MockSocket, loadDemoEvents } from "./helpers/stream.js";

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
  beforeEach(() => MockSocket.reset());

  it("replays the demo into the dashboard and the navigation", async () => {
    const { store, server } = renderWithStore(<App search="" />, handlers());
    store.start();
    const ws = MockSocket.instances[0]!;
    expect(ws.url).toBe("ws://localhost:3000/api/v1/events?token=t");
    act(() => ws.open());
    expect(screen.getByText("● Live")).toBeInTheDocument();
    await waitFor(() => expect(server.callsTo("stats.refresh")).toHaveLength(1));
    act(() => ws.replay(events));

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

  it("opens the launcher prefilled from the deep link", async () => {
    renderWithStore(<App search={`?project=${project.project.id}`} />, handlers());
    await waitFor(() => expect(screen.getByLabelText("Container")).toHaveValue(project.project.id));
  });
});
