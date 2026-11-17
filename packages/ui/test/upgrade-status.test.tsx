import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/react";
import { EventHub } from "../src/events/hub";
import { EventHubProvider } from "../src/events/react";
import { FakeServer } from "../src/testing/FakeServer";
import { UpgradeStatus } from "../src/components/UpgradeStatus";

function mount(server: FakeServer, onRelaunch = vi.fn()) {
  const hub = new EventHub();
  const client = new ApiClient({ baseUrl: "http://localhost", token: "t", fetch: server.fetch });
  render(
    <ApiClientProvider client={client}>
      <EventHubProvider hub={hub}>
        <UpgradeStatus runningVersion="1.0.0" onRelaunch={onRelaunch} />
      </EventHubProvider>
    </ApiClientProvider>,
  );
  return hub;
}

describe("app upgrade status", () => {
  it("reloads update, image and machine status after reconnect and clears stale CLI notices", async () => {
    const server = new FakeServer();
    server.state.updates.claudeCode = { latest: "2.0.0", image: "1.0.0", stale: true };
    const hub = mount(server);
    await screen.findByText(/Claude Code 2.0.0 is available/);
    const before = server.callsTo("machines.list").length;
    act(() => hub.setStatus("closed"));
    server.state.updates.claudeCode = { latest: "2.0.0", image: "2.0.0", stale: false };
    act(() => hub.setStatus("open"));
    act(() => hub.resync());
    await waitFor(() => expect(screen.queryByText(/Claude Code 2.0.0 is available/)).toBeNull());
    expect(server.callsTo("updates.check").length).toBeGreaterThan(1);
    expect(server.callsTo("updates.check").every((call) => call.query.force === false)).toBe(true);
    expect(server.callsTo("image.status").length).toBeGreaterThan(1);
    expect(server.callsTo("machines.list").length).toBeGreaterThan(before);
  });
  it("shows the image upgrade and a build log link", async () => {
    const server = new FakeServer();
    server.state.image.upgrading = true;
    server.state.image.buildLogJobId = "build-1";
    mount(server);
    await screen.findByText("Upgrading: building the image");
    expect(screen.getByRole("link", { name: "Build log" })).toHaveAttribute(
      "href",
      "http://localhost/api/v1/jobs/build-1",
    );
  });

  it("polls only the image status during an upgrade and checks updates once it ends", async () => {
    const server = new FakeServer();
    server.state.image.upgrading = true;
    mount(server);
    await waitFor(() => expect(server.callsTo("image.status").length).toBeGreaterThan(1), {
      timeout: 3000,
    });
    const checks = server.callsTo("updates.check").length;
    expect(server.callsTo("updates.check").every((call) => call.query.force === false)).toBe(true);
    server.state.image.upgrading = false;
    await waitFor(() => expect(server.callsTo("updates.check").length).toBe(checks + 1), {
      timeout: 3000,
    });
  });

  it("offers to relaunch an app older than the installed package", async () => {
    const server = new FakeServer();
    server.state.updates.installedVersion = "1.1.0";
    const relaunch = vi.fn();
    mount(server, relaunch);
    await screen.findByText(/1.1.0 is installed.*relaunch/i);
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("lists the work a CLI update will stop, cancels safely, and starts only after confirmation", async () => {
    const server = new FakeServer();
    server.on("upgrade.preview", () => ({
      boxes: [{ id: "box1", name: "My box" }],
      runs: [{ run_id: "run1", name: "My review" }],
    }));
    server.on("upgrade.start", () => ({
      image: "latest" as const,
      fallback: false,
      error: null,
      boxes: [],
      runs: [],
    }));
    mount(server);
    fireEvent.click(screen.getByRole("button", { name: "CLI update" }));
    await screen.findByText("My box");
    expect(screen.getByText("My review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(server.callsTo("upgrade.start")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "CLI update" }));
    await screen.findByText("My box");
    fireEvent.click(screen.getByRole("button", { name: "Update CLIs" }));
    await waitFor(() => expect(server.callsTo("upgrade.start")).toHaveLength(1));
  });

  it("names both versions only for remote machines older than the hub", async () => {
    const server = new FakeServer();
    const machine = (id: string, name: string, version: string, isLocal = false) => ({
      id,
      name,
      role: "both" as const,
      status: "online" as const,
      isLocal,
      serverVersion: version,
      protocol: 1,
      capabilities: [],
      lastSeen: null,
      platform: "linux" as const,
    });
    server.on("machines.list", () => ({
      machines: [
        machine("local", "Hub", "1.10.0", true),
        machine("old", "Old laptop", "1.9.0"),
        machine("same", "Same laptop", "1.10.0"),
        machine("new", "New laptop", "1.11.0"),
      ],
    }));
    mount(server);
    await screen.findByText(
      "Old laptop runs 1.9.0; the hub runs 1.10.0. Upgrade Old laptop on that machine.",
    );
    expect(screen.queryByText(/Same laptop runs/)).toBeNull();
    expect(screen.queryByText(/New laptop runs/)).toBeNull();
  });

  it.each(["1.0.0", "0.9.0", "1.0.0-beta.1"])(
    "does not offer relaunch for installed %s",
    async (installedVersion) => {
      const server = new FakeServer();
      server.state.updates.installedVersion = installedVersion;
      mount(server);
      await waitFor(() => expect(server.callsTo("updates.check")).toHaveLength(1));
      expect(screen.queryByRole("button", { name: "Relaunch" })).toBeNull();
    },
  );
});
