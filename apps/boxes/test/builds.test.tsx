// The Builds page and the build badge on a box, against the fake server.
import { FakeServer, makeBoxView, makeBuild } from "@aio/ui/testing";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/app/App";
import { renderWithServer } from "./helpers";

const B1 = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const B2 = "01JB8Z5K3W6Q2V9X4T7R0M1N2R";
const B3 = "01JB8Z5K3W6Q2V9X4T7R0M1N2S";
const B4 = "01JB8Z5K3W6Q2V9X4T7R0M1N2T";

const site = () =>
  makeBoxView({
    box: { id: "aio-agent-site", targetDir: "/w/site", conversationName: "Site work" },
    status: "running",
  });

async function renderApp(server: FakeServer) {
  const utils = renderWithServer(<App />, server);
  await screen.findByRole("cell", { name: "Site work" });
  return utils;
}

const buildsTable = () => screen.getByRole("table", { name: "Builds" });
const buildRow = (slug: string) =>
  within(buildsTable()).getByRole("cell", { name: slug }).closest("tr") as HTMLElement;
/** A build row's State, Build, and Step cells. */
const stateOf = (slug: string) =>
  within(buildRow(slug))
    .getAllByRole("cell")
    .slice(0, 3)
    .map((c) => c.textContent);

describe("Builds page", () => {
  it("lists the machine's builds with their state and step", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({
      boxes: [site()],
      builds: [
        makeBuild({ id: B1, slug: "add-export", status: "paused", step: "tasks" }),
        makeBuild({ id: B2, slug: "drop-legacy", status: "cancelled", step: "harden" }),
        makeBuild({ id: B3, slug: "ship-search", status: "finished", step: "release_ready" }),
        makeBuild({ id: B4, slug: "plan-auth", status: "planning", step: null }),
      ],
    });
    await renderApp(server);
    await user.click(screen.getByRole("tab", { name: "Builds" }));
    await screen.findByRole("table", { name: "Builds" });
    expect(stateOf("add-export")).toEqual(["Paused", "add-export", "Tasks"]);
    expect(stateOf("drop-legacy")).toEqual(["Canceled", "drop-legacy", "Harden"]);
    expect(stateOf("ship-search")).toEqual(["Release ready", "ship-search", "Release ready"]);
    expect(stateOf("plan-auth")).toEqual(["Planning", "plan-auth", "Not started"]);
  });

  it("adds and updates builds from the event stream without a reload", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({
      boxes: [site()],
      builds: [makeBuild({ id: B1, slug: "add-export", status: "running", step: "tasks" })],
    });
    await renderApp(server);
    await user.click(screen.getByRole("tab", { name: "Builds" }));
    await screen.findByRole("table", { name: "Builds" });
    const lists = server.callsTo("builds.list").length;
    act(() => {
      server.putBuild(
        makeBuild({ id: B2, slug: "drop-legacy", createdAt: "2026-10-28T10:00:00Z" }),
      );
      server.putBuild(
        makeBuild({
          id: B1,
          slug: "add-export",
          status: "paused",
          step: "integrate",
          updatedAt: "2026-10-28T11:00:00Z",
        }),
      );
    });
    await waitFor(() => expect(stateOf("add-export")).toEqual(["Paused", "add-export", "Integrate"]));
    expect(stateOf("drop-legacy")).toEqual(["Running", "drop-legacy", "Tasks"]);
    expect(server.callsTo("builds.list").length).toBe(lists);
  });

  it("ignores an event older than the state it shows", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({
      boxes: [site()],
      builds: [
        makeBuild({
          id: B1,
          slug: "add-export",
          status: "paused",
          updatedAt: "2026-10-28T11:00:00Z",
        }),
      ],
    });
    await renderApp(server);
    await user.click(screen.getByRole("tab", { name: "Builds" }));
    await screen.findByRole("table", { name: "Builds" });
    act(() => {
      server.emit({
        type: "build.changed",
        id: "old",
        time: "2026-10-28T09:00:00Z",
        source: "server",
        streamId: server.streamId,
        seq: 0,
        sourceSeq: 0,
        build: makeBuild({ id: B1, slug: "add-export", status: "running" }),
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stateOf("add-export")[0]).toBe("Paused");
  });
});

describe("build badge", () => {
  it("appears on the box that runs a build and clears when the build ends", async () => {
    const server = new FakeServer({ boxes: [site()] });
    await renderApp(server);
    const row = () => screen.getByRole("cell", { name: "Site work" }).closest("tr") as HTMLElement;
    expect(within(row()).queryByRole("button", { name: /build/i })).toBeNull();
    act(() => {
      server.putBuild(makeBuild({ id: B1, slug: "add-export", boxId: "aio-agent-site" }));
    });
    expect(
      await within(row()).findByRole("button", { name: "Open build add-export (Running)" }),
    ).toBeInTheDocument();
    act(() => {
      server.putBuild(
        makeBuild({
          id: B1,
          slug: "add-export",
          boxId: "aio-agent-site",
          status: "finished",
          updatedAt: "2026-10-28T12:00:00Z",
        }),
      );
    });
    await waitFor(() => expect(within(row()).queryByRole("button", { name: /build/i })).toBeNull());
  });

  it("opens the build on the Builds page", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({
      boxes: [site()],
      builds: [
        makeBuild({ id: B1, slug: "add-export", boxId: "aio-agent-site", status: "paused" }),
        makeBuild({ id: B2, slug: "drop-legacy", createdAt: "2026-10-28T10:00:00Z" }),
      ],
    });
    await renderApp(server);
    await user.click(await screen.findByRole("button", { name: "Open build add-export (Paused)" }));
    expect(screen.getByRole("tab", { name: "Builds" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(buildRow("add-export")).toHaveAttribute("aria-selected", "true"));
    expect(buildRow("drop-legacy")).toHaveAttribute("aria-selected", "false");
  });
});
