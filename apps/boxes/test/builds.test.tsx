// The Builds page and the build badge on a box, against the fake server.
import { FakeApiError, FakeServer, makeBoxView, makeBuild, makeInboxItem, makeMessage } from "@aio/ui/testing";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import type { AioBridge } from "../src/bridge";
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
  it("subscribes to the build events, which the server sends only on request", async () => {
    const server = new FakeServer({ boxes: [site()] });
    await renderApp(server);
    const socket = server.socketsFor("/api/v1/events")[0];
    const types = socket?.query.get("types")?.split(",") ?? [];
    for (const type of [
      "build.changed",
      "build.task.changed",
      "build.inbox",
      "message.sent",
      "lease.settled",
    ]) {
      expect(types).toContain(type);
    }
  });

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
    await waitFor(() =>
      expect(stateOf("add-export")).toEqual(["Paused", "add-export", "Integrate"]),
    );
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

describe("build view on the Builds page", () => {
  it("shows the selected build's messages under the list", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({
      boxes: [site()],
      builds: [
        makeBuild({ id: B1, slug: "add-export" }),
        makeBuild({ id: B2, slug: "drop-legacy", createdAt: "2026-10-28T10:00:00Z" }),
      ],
    });
    server.state.buildMessages[B1] = [makeMessage({ id: "M1", buildId: B1, body: "Export how?" })];
    server.state.buildMessages[B2] = [makeMessage({ id: "M1", buildId: B2, body: "Drop what?" })];
    await renderApp(server);
    await user.click(screen.getByRole("tab", { name: "Builds" }));
    await user.click(await within(buildsTable()).findByRole("cell", { name: "add-export" }));
    const messages = await screen.findByRole("list", { name: "Messages" });
    await waitFor(() => expect(messages).toHaveTextContent("Export how?"));
    await user.click(within(buildsTable()).getByRole("cell", { name: "drop-legacy" }));
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Messages" })).toHaveTextContent("Drop what?"),
    );
    expect(screen.getByRole("list", { name: "Messages" })).not.toHaveTextContent("Export how?");
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

describe("waiting escalations", () => {
  afterEach(() => {
    delete window.aio;
  });

  /** A running build with an escalation that waits, a digest, and an answered escalation. */
  function serverWithInbox() {
    const server = new FakeServer({
      boxes: [site()],
      builds: [
        makeBuild({ id: B1, slug: "add-export", boxId: "aio-agent-site" }),
        makeBuild({ id: B2, slug: "drop-legacy", createdAt: "2026-10-28T10:00:00Z" }),
      ],
    });
    server.state.buildInbox[B1] = [
      makeInboxItem({ id: "I1", ref: "E1", summary: "Escalation E1: Task T1 failed 4 attempts." }),
      makeInboxItem({
        id: "I2",
        kind: "digest",
        ref: "milestone-M1",
        summary: "Milestone M1 is done.",
        file: "digests/milestone-M1.md",
        needsAnswer: false,
      }),
      makeInboxItem({
        id: "I3",
        ref: "E2",
        deliveredAt: "2026-10-28T09:01:00Z",
        answeredAt: "2026-10-28T09:05:00Z",
      }),
    ];
    return server;
  }

  it("shows a build's open escalations in the list and in the build view", async () => {
    const user = userEvent.setup();
    await renderApp(serverWithInbox());
    await user.click(screen.getByRole("tab", { name: "Builds" }));
    await screen.findByRole("table", { name: "Builds" });
    await waitFor(() =>
      expect(within(buildRow("add-export")).getByText("1 open")).toBeInTheDocument(),
    );
    expect(within(buildRow("drop-legacy")).queryByText(/open/)).toBeNull();
    await user.click(within(buildsTable()).getByRole("cell", { name: "add-export" }));
    const open = await screen.findByRole("list", { name: "Open escalations" });
    expect(within(open).getAllByRole("listitem")).toHaveLength(1);
    expect(open).toHaveTextContent("Escalation E1: Task T1 failed 4 attempts.");
    expect(open).toHaveTextContent("escalations/E1.json");
  });

  it("resolves an escalation as the owner from the build view", async () => {
    const user = userEvent.setup();
    const server = serverWithInbox();
    await renderApp(server);
    await user.click(screen.getByRole("tab", { name: "Builds" }));
    await screen.findByRole("table", { name: "Builds" });
    await user.click(within(buildsTable()).getByRole("cell", { name: "add-export" }));
    await screen.findByRole("list", { name: "Open escalations" });

    await user.click(screen.getByRole("button", { name: "Resolve E1" }));
    const form = screen.getByRole("form", { name: "Resolve E1" });
    await user.selectOptions(within(form).getByRole("combobox", { name: "Action" }), "clarify");
    // A clarification needs its text, so the form waits for it.
    expect(within(form).getByRole("button", { name: "Resolve" })).toBeDisabled();
    await user.type(within(form).getByRole("textbox", { name: "Note" }), "Use whole dollars.");
    await user.click(within(form).getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(server.callsTo("builds.resolve")).toHaveLength(1));
    const call = server.callsTo("builds.resolve")[0];
    expect(call?.params).toMatchObject({ buildId: B1 });
    expect(call?.body).toMatchObject({
      escalation: "E1",
      action: "clarify",
      by: "owner",
      note: "Use whole dollars.",
    });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Open escalations" })).toBeNull());
  });

  it("sends a reorder's task order and a decision's answer, and shows a refusal", async () => {
    const user = userEvent.setup();
    const server = serverWithInbox();
    await renderApp(server);
    await user.click(screen.getByRole("tab", { name: "Builds" }));
    await screen.findByRole("table", { name: "Builds" });
    await user.click(within(buildsTable()).getByRole("cell", { name: "add-export" }));
    await screen.findByRole("list", { name: "Open escalations" });

    await user.click(screen.getByRole("button", { name: "Resolve E1" }));
    const form = screen.getByRole("form", { name: "Resolve E1" });
    await user.selectOptions(within(form).getByRole("combobox", { name: "Action" }), "reorder");
    await user.type(within(form).getByRole("textbox", { name: "Task order" }), "T2, T1");
    server.on("builds.resolve", () => {
      throw new FakeApiError("invalid_state", "Task T2 depends on T1.", 409);
    });
    await user.click(within(form).getByRole("button", { name: "Resolve" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Task T2 depends on T1.");
    server.overrides.delete("builds.resolve");
    expect(server.callsTo("builds.resolve")[0]?.body).toMatchObject({
      action: "reorder",
      order: ["T2", "T1"],
    });

    await user.selectOptions(within(form).getByRole("combobox", { name: "Action" }), "decide");
    await user.selectOptions(within(form).getByRole("combobox", { name: "Decision" }), "cancel");
    await user.click(within(form).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(server.callsTo("builds.resolve")).toHaveLength(2));
    expect(server.callsTo("builds.resolve")[1]?.body).toMatchObject({
      action: "decide",
      decision: { option: "cancel" },
    });
  });

  it("follows the inbox from the event stream", async () => {
    const user = userEvent.setup();
    const server = serverWithInbox();
    await renderApp(server);
    await user.click(screen.getByRole("tab", { name: "Builds" }));
    await waitFor(() =>
      expect(within(buildRow("add-export")).getByText("1 open")).toBeInTheDocument(),
    );
    act(() => server.putInboxItem(B1, makeInboxItem({ id: "I4", ref: "E3" })));
    await waitFor(() =>
      expect(within(buildRow("add-export")).getByText("2 open")).toBeInTheDocument(),
    );
    act(() => {
      for (const id of ["I1", "I4"]) {
        const item = server.state.buildInbox[B1]?.find((i) => i.id === id);
        if (item) {
          server.putInboxItem(B1, {
            ...item,
            deliveredAt: "2026-10-28T09:10:00Z",
            answeredAt: "2026-10-28T09:20:00Z",
          });
        }
      }
    });
    await waitFor(() => expect(within(buildRow("add-export")).queryByText(/open/)).toBeNull());
  });

  it("doesn't notify again about an escalation after an app restart", async () => {
    const notifyBuild = vi.fn();
    window.aio = {
      onSelectBox: () => () => undefined,
      notifyBuild,
      onSelectBuild: () => () => undefined,
    } as unknown as AioBridge;
    const server = serverWithInbox();
    const first = await renderApp(server);
    await waitFor(() => expect(notifyBuild).toHaveBeenCalledTimes(1));
    first.unmount();

    await renderApp(server);
    act(() =>
      server.putInboxItem(B1, makeInboxItem({ id: "I5", ref: "E4", summary: "E4 waits." })),
    );
    await waitFor(() => expect(notifyBuild).toHaveBeenCalledTimes(2));
    expect(notifyBuild).toHaveBeenLastCalledWith(expect.objectContaining({ body: "E4 waits." }));
    await new Promise((r) => setTimeout(r, 50));
    expect(notifyBuild).toHaveBeenCalledTimes(2);
  });

  it("notifies the owner once per escalation that didn't reach the session", async () => {
    const notifyBuild = vi.fn();
    let select: ((buildId: string, machineId?: string) => void) | undefined;
    window.aio = {
      onSelectBox: () => () => undefined,
      notifyBuild,
      onSelectBuild: (listener: (buildId: string, machineId?: string) => void) => {
        select = listener;
        return () => undefined;
      },
    } as unknown as AioBridge;
    const server = serverWithInbox();
    // A delivered escalation waits for the Project manager's answer, not for the owner.
    server.state.buildInbox[B2] = [
      makeInboxItem({ id: "I1", ref: "E1", deliveredAt: "2026-10-28T09:01:00Z" }),
    ];
    await renderApp(server);
    await waitFor(() => expect(notifyBuild).toHaveBeenCalledTimes(1));
    expect(notifyBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Escalation waits in add-export",
        body: "Escalation E1: Task T1 failed 4 attempts.",
        buildId: B1,
        machineId: "local",
      }),
    );

    // The same escalation again notifies nobody; another one does.
    act(() => {
      server.putInboxItem(B1, makeInboxItem({ id: "I1", ref: "E1", summary: "Again." }));
    });
    act(() =>
      server.putInboxItem(B1, makeInboxItem({ id: "I5", ref: "E4", summary: "E4 waits." })),
    );
    await waitFor(() => expect(notifyBuild).toHaveBeenCalledTimes(2));
    expect(notifyBuild).toHaveBeenLastCalledWith(expect.objectContaining({ body: "E4 waits." }));
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyBuild).toHaveBeenCalledTimes(2);

    // A click opens the build.
    act(() => select?.(B1, "local"));
    expect(screen.getByRole("tab", { name: "Builds" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(buildRow("add-export")).toHaveAttribute("aria-selected", "true"));
  });
});
