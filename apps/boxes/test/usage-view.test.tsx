// The Model usage panel: polling, a failed refresh, and clearing a block.
import type { VendorUsageSchema } from "@aio/contracts";
import { FakeServer } from "@aio/ui/testing";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageView } from "../src/components/UsageView";
import { renderWithServer } from "./helpers";

type Usage = z.infer<typeof VendorUsageSchema>;

const vendor = (over: boolean): Usage =>
  ({
    vendor: "codex",
    account: "codex/work",
    ceiling: { kind: "utilization", window: "5h", max: 0.7 },
    latest: [
      {
        vendor: "codex",
        account: "codex/work",
        window: "5h",
        utilization: over ? 1 : 0.1,
        spendUsd: null,
        ceiling: { kind: "utilization", window: "5h", max: 0.7 },
        resetAt: "2030-01-01T00:00:00.000Z",
        sampleSource: "codex_session",
        time: "2029-12-31T23:00:00.000Z",
      },
    ],
    overCeiling: over,
    forecastAt: null,
    resetAt: "2030-01-01T00:00:00.000Z",
    window: "5h",
  }) as Usage;

const confirmYes = async () =>
  within(await screen.findByRole("dialog", { name: "Clear Block" })).getByRole("button", {
    name: "Yes",
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("UsageView", () => {
  it("clears a block and reads usage again", async () => {
    const server = new FakeServer();
    let over = true;
    server.on("usage.get", () => ({ vendors: [vendor(over)], time: "2029-12-31T23:30:00.000Z" }));
    server.on("usage.clear", () => {
      over = false;
      return { vendors: [vendor(false)], cleared: 1 };
    });
    renderWithServer(<UsageView boxes={[]} disk={new Map()} />, server);
    await userEvent.click(await screen.findByRole("button", { name: "Clear block" }));
    await userEvent.click(await confirmYes());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Clear block" })).not.toBeInTheDocument(),
    );
    expect(server.callsTo("usage.clear")[0]?.body).toEqual({
      vendor: "codex",
      account: "codex/work",
    });
  });

  it("says so when a refresh fails, and keeps the old readings", async () => {
    const server = new FakeServer();
    let failing = false;
    server.on("usage.get", () => {
      if (failing) throw new Error("no server");
      return { vendors: [vendor(false)], time: "2029-12-31T23:30:00.000Z" };
    });
    renderWithServer(<UsageView boxes={[]} disk={new Map()} />, server);
    await screen.findByText("codex/work");
    failing = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't refresh usage/);
    expect(screen.getByText("codex/work")).toBeInTheDocument();
  });

  it("stops polling once unmounted, and while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = new FakeServer();
    server.on("usage.get", () => ({ vendors: [], time: "2029-12-31T23:30:00.000Z" }));
    const { unmount } = renderWithServer(<UsageView boxes={[]} disk={new Map()} />, server);
    await vi.waitFor(() => expect(server.callsTo("usage.get").length).toBeGreaterThan(0));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const before = server.callsTo("usage.get").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(server.callsTo("usage.get")).toHaveLength(before);
    hidden.mockRestore();
    unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.callsTo("usage.get")).toHaveLength(before);
  });

  it("asks first, and clears nothing when you say no", async () => {
    const server = new FakeServer();
    server.on("usage.get", () => ({ vendors: [vendor(true)], time: "2029-12-31T23:30:00.000Z" }));
    server.on("usage.clear", () => ({ vendors: [vendor(false)], cleared: 1 }));
    renderWithServer(<UsageView boxes={[]} disk={new Map()} />, server);
    await userEvent.click(await screen.findByRole("button", { name: "Clear block" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear Block" });
    await userEvent.click(within(dialog).getByRole("button", { name: "No" }));
    expect(server.callsTo("usage.clear")).toHaveLength(0);
  });

  it("says when the server clears nothing, and when the clear fails", async () => {
    const server = new FakeServer();
    server.on("usage.get", () => ({ vendors: [vendor(true)], time: "2029-12-31T23:30:00.000Z" }));
    let fail = false;
    server.on("usage.clear", () => {
      if (fail) throw new Error("server down");
      return { vendors: [vendor(true)], cleared: 0 };
    });
    renderWithServer(<UsageView boxes={[]} disk={new Map()} />, server);
    await userEvent.click(await screen.findByRole("button", { name: "Clear block" }));
    await userEvent.click(await confirmYes());
    expect(await screen.findByText(/cleared nothing/)).toBeInTheDocument();
    fail = true;
    await userEvent.click(await screen.findByRole("button", { name: "Clear block" }));
    await userEvent.click(await confirmYes());
    expect(await screen.findByText(/Couldn't clear the block/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't refresh usage/)).not.toBeInTheDocument();
  });
});
