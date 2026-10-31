import { addUsageSamples, Dashboard, replay, emptyDashboard } from "../../src/dashboard";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildDemoEvents, DEMO_CONTAINER as CONTAINER } from "../../src/testing/demoRun";

const events = buildDemoEvents();
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

  it("draws no ceiling on a window the ceiling doesn't govern, and marks estimates", () => {
    const sample = (time: string, utilization: number) => ({
      vendor: "claude" as const,
      account: "a@example.com",
      window: "7d" as const,
      utilization,
      spendUsd: null,
      ceiling: { kind: "utilization" as const, window: "5h" as const, max: 0.6 },
      resetAt: null,
      sampleSource: "estimate" as const,
      time,
    });
    const state = addUsageSamples(emptyDashboard(), [
      sample("2026-10-28T09:00:00.000Z", 0.55),
      sample("2026-10-28T09:30:00.000Z", 0.65),
    ]);
    // The server forecasts this window, but the ceiling doesn't govern it.
    const usageInfo = [
      {
        vendor: "claude" as const,
        account: "a@example.com",
        window: "7d" as const,
        forecastAt: "2026-10-28T11:00:00.000Z",
        resetAt: null,
      },
    ];
    const { container } = render(<Dashboard state={state} usageInfo={usageInfo} now={NOW} />);
    const usage = screen.getByRole("region", { name: "Usage against ceilings" });
    expect(within(usage).queryByText(/Over ceiling/)).not.toBeInTheDocument();
    expect(within(usage).getByText("No ceiling for this window")).toBeInTheDocument();
    expect(within(usage).getByRole("img", { name: /no ceiling/ })).toBeInTheDocument();
    expect(container.querySelector(".ab-ceiling")).toBeNull();
    expect(within(usage).queryByText("Ceiling")).not.toBeInTheDocument();
    expect(within(usage).queryByText(/Reaches the ceiling/)).not.toBeInTheDocument();
    // The forecast marker is the faint line from the last point to the ceiling.
    expect(container.querySelector('line[stroke-opacity="0.4"]')).toBeNull();
    expect(container.querySelector("[data-estimated]")).not.toBeNull();
    fireEvent.click(within(usage).getByRole("button", { name: "Table" }));
    expect(within(usage).getByRole("columnheader", { name: "Source" })).toBeInTheDocument();
    expect(within(usage).getByRole("cell", { name: "estimate" })).toBeInTheDocument();
    const cells = within(usage).getAllByRole("cell");
    const headers = within(usage)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(cells[headers.indexOf("Ceiling")]).toHaveTextContent("–");
    expect(cells[headers.indexOf("Forecast")]).toHaveTextContent("–");
  });

  it("draws the forecast marker and the ceiling label when the ceiling governs the window", () => {
    const sample = (time: string, utilization: number) => ({
      vendor: "claude" as const,
      account: "a@example.com",
      window: "5h" as const,
      utilization,
      spendUsd: null,
      ceiling: { kind: "utilization" as const, window: "5h" as const, max: 0.6 },
      resetAt: null,
      sampleSource: "rate_limit_event" as const,
      time,
    });
    const state = addUsageSamples(emptyDashboard(), [
      sample("2026-10-28T09:00:00.000Z", 0.4),
      sample("2026-10-28T09:30:00.000Z", 0.5),
    ]);
    const { container } = render(<Dashboard state={state} now={NOW} />);
    const usage = screen.getByRole("region", { name: "Usage against ceilings" });
    expect(within(usage).getByText("Ceiling")).toBeInTheDocument();
    expect(within(usage).getByText(/Reaches the ceiling/)).toBeInTheDocument();
    expect(container.querySelector('line[stroke-opacity="0.4"]')).not.toBeNull();
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
