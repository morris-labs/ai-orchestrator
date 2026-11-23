import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AioEvent, Notification } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/react";
import { EventHub } from "../src/events/hub";
import { EventHubProvider } from "../src/events/react";
import { FakeServer } from "../src/testing/FakeServer";
import { UsageAlerts } from "../src/components/UsageAlerts";

function mount(server: FakeServer) {
  const hub = new EventHub();
  const client = new ApiClient({ baseUrl: "http://localhost", token: "t", fetch: server.fetch });
  render(
    <ApiClientProvider client={client}>
      <EventHubProvider hub={hub}>
        <UsageAlerts />
      </EventHubProvider>
    </ApiClientProvider>,
  );
  return hub;
}

const alert = (fields: Partial<Notification> = {}): Notification => ({
  notificationId: "n-1",
  kind: "usage_alert",
  title: "Claude 5-hour usage is at 84%",
  body: "At the current rate it reaches the limit before the window resets.",
  runId: null,
  boxId: null,
  severity: "warning",
  read: false,
  ...fields,
});

const event = (n: Notification): AioEvent =>
  ({
    type: "notification",
    id: `e-${n.notificationId}`,
    time: "2026-10-28T09:00:00.000Z",
    source: "server",
    streamId: "s",
    seq: 1,
    sourceSeq: 1,
    ...n,
  }) as AioEvent;

describe("usage alerts", () => {
  it("shows the unread usage alerts the server holds, and no other notifications", async () => {
    const server = new FakeServer();
    server.state.notifications = [
      alert(),
      alert({ notificationId: "n-2", read: true, title: "Old alert" }),
      alert({ notificationId: "n-3", kind: "run_finished", title: "Run finished" }),
    ];
    mount(server);

    const region = await screen.findByRole("region", { name: "Usage alerts" });
    expect(within(region).getByText("Claude 5-hour usage is at 84%")).toBeInTheDocument();
    expect(within(region).queryByText("Old alert")).toBeNull();
    expect(within(region).queryByText("Run finished")).toBeNull();
  });

  it("shows an alert as it arrives and marks it read when dismissed", async () => {
    const server = new FakeServer();
    const hub = mount(server);
    await waitFor(() => expect(server.callsTo("notifications.list").length).toBe(1));
    expect(screen.queryByRole("region", { name: "Usage alerts" })).toBeNull();

    act(() => hub.emit(event(alert({ notificationId: "n-9", title: "Codex usage jumped" }))));
    const region = await screen.findByRole("region", { name: "Usage alerts" });
    expect(within(region).getByText("Codex usage jumped")).toBeInTheDocument();

    fireEvent.click(within(region).getByRole("button", { name: "Dismiss Codex usage jumped" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Usage alerts" })).toBeNull());
    expect(server.callsTo("notifications.read").map((c) => c.params.notificationId)).toEqual([
      "n-9",
    ]);
  });
});
