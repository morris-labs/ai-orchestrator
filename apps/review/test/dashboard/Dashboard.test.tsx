import { Dashboard, replay, emptyDashboard } from "@agentbox/ui/dashboard";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CONTAINER } from "../../scripts/demoIds.js";
import { loadDemoEvents } from "../helpers/stream.js";

const events = loadDemoEvents();
const NOW = Date.parse("2026-10-28T10:00:00.000Z");

describe("Dashboard", () => {
  it("renders an empty state before any event", () => {
    render(<Dashboard state={emptyDashboard()} now={NOW} />);
    expect(screen.getByText(/No container has reported yet/)).toBeInTheDocument();
    expect(screen.getByText("No agent has started.")).toBeInTheDocument();
    expect(screen.getByText("No usage sample yet.")).toBeInTheDocument();
  });

  it("shows every panel from the replayed demo stream", () => {
    const state = replay(events);
    render(<Dashboard state={state} now={NOW} connection="open" />);

    const fleet = screen.getByRole("region", { name: "Fleet" });
    expect(within(fleet).getByText(CONTAINER)).toBeInTheDocument();
    expect(within(fleet).getByText(/Matches/)).toBeInTheDocument();
    expect(within(fleet).getByText(/merge, round 2/)).toBeInTheDocument();

    const flow = screen.getByRole("img", { name: /Data flow with \d+ edges/ });
    expect(flow.querySelectorAll("path").length).toBeGreaterThan(5);

    const agents = screen.getByRole("region", { name: "Agents" });
    expect(within(agents).getAllByRole("row").length).toBeGreaterThan(5);

    const usage = screen.getByRole("region", { name: "Usage against ceilings" });
    expect(within(usage).getByText(/Over ceiling/)).toBeInTheDocument();
    expect(within(usage).getAllByRole("img")).toHaveLength(3);

    const health = screen.getByRole("region", { name: "Run health" });
    const funnel = within(health).getByRole("list", { name: "Finding funnel" });
    expect(
      within(funnel)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Raised8", "Merged6", "Confirmed2", "Fixed2"]);
    expect(screen.getByText("● Live")).toBeInTheDocument();
  });

  it("switches a chart to its table view", () => {
    render(<Dashboard state={replay(events)} now={NOW} />);
    const health = screen.getByRole("region", { name: "Run health" });
    fireEvent.click(within(health).getByRole("button", { name: "Table" }));
    expect(
      within(health).getByRole("columnheader", { name: "Codex confirmed" }),
    ).toBeInTheDocument();
    expect(within(health).getByText(/2 \(in progress\)/)).toBeInTheDocument();
  });

  it("drives the dashboard step by step as events arrive", () => {
    const { rerender } = render(<Dashboard state={replay(events.slice(0, 5))} now={NOW} />);
    expect(screen.getByText(/No run yet/)).toBeInTheDocument();
    rerender(<Dashboard state={replay(events.slice(0, 20))} now={NOW} />);
    expect(screen.getByRole("img", { name: /Data flow with [1-9]\d* edges/ })).toBeInTheDocument();
    rerender(<Dashboard state={replay(events)} now={NOW} />);
    expect(screen.getAllByText(/needs|waiting decision/).length).toBeGreaterThan(0);
  });

  it("shows a tooltip on keyboard focus of the usage chart", () => {
    render(<Dashboard state={replay(events)} now={NOW} />);
    const chart = screen.getAllByRole("img", { name: /Claude usage/ })[0]!;
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent(/used/);
  });
});
