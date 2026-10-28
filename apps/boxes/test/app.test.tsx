import { FakeApiError, FakeServer, makeBoxView, makeEvent } from "@agentbox/ui/testing";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/app/App";
import { renderWithServer } from "./helpers";

const UUID = "11111111-1111-4111-8111-111111111111";

function boxes() {
  return [
    makeBoxView({
      box: {
        id: "claude-agent-site",
        targetDir: "/w/site",
        conversationName: "Site work",
        sessionUuid: UUID,
      },
      status: "running",
    }),
    makeBoxView({
      box: {
        id: "claude-agent-api",
        targetDir: "/w/api",
        conversationName: "Api",
        worktree: "/w/api/.worktrees/Api",
        branch: "claude/Api",
      },
      status: "stopped",
    }),
  ];
}

async function renderApp(server: FakeServer) {
  const utils = renderWithServer(<App />, server);
  await screen.findByRole("cell", { name: "Site work" });
  return utils;
}

const rowOf = (name: string) => screen.getByRole("cell", { name }).closest("tr") as HTMLElement;

describe("main window", () => {
  it("lists boxes with all four columns, counts, and projects", async () => {
    await renderApp(new FakeServer({ boxes: boxes() }));
    expect(
      screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/\s.$/, "")),
    ).toEqual(["Status", "Directory", "Conversation", "Container"]);
    expect(screen.getByText("1 running \u00b7 1 not running")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "All projects (2)" })).toBeInTheDocument();
    expect(screen.getByText(/^updated \d\d:\d\d:\d\d$/)).toBeInTheDocument();
  });

  it("sorts running boxes first and selects the first row", async () => {
    await renderApp(new FakeServer({ boxes: boxes().reverse() }));
    const first = screen.getAllByRole("row")[1] as HTMLElement;
    expect(within(first).getByText("Site work")).toBeInTheDocument();
    await waitFor(() => expect(first).toHaveAttribute("aria-selected", "true"));
  });

  it("filters by container name and reports what it hides", async () => {
    const user = userEvent.setup();
    await renderApp(new FakeServer({ boxes: boxes() }));
    await user.type(screen.getByLabelText("Filter boxes"), "agent-api");
    expect(screen.queryByRole("cell", { name: "Site work" })).toBeNull();
    expect(screen.getByRole("cell", { name: "Api" })).toBeInTheDocument();
    expect(screen.getByText(/1 hidden by filter/)).toBeInTheDocument();
  });

  it("narrows the table to a project", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    await user.click(screen.getByRole("option", { name: /^api/ }));
    expect(screen.queryByRole("cell", { name: "Site work" })).toBeNull();
  });

  it("stops every running box with Ctrl+Shift+A after a confirmation", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    await user.keyboard("{Control>}{Shift>}A{/Shift}{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Stop All" });
    expect(dialog).toHaveTextContent("Stop 1 running box(es)?");
    await user.click(within(dialog).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(server.callsTo("boxes.stopAll")).toHaveLength(1));
  });

  it("refuses Purge while a box runs against the directory", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    await user.pointer({ keys: "[MouseLeft>]", target: rowOf("Site work") });
    await user.click(screen.getByRole("button", { name: "Purge" }));
    expect(await screen.findByRole("dialog", { name: "Purge" })).toHaveTextContent(
      "claude-agent-site is running against this directory. Stop it first.",
    );
    expect(server.callsTo("boxes.purge")).toHaveLength(0);
  });

  it("lists what Purge removes before it runs", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    fireEvent.mouseDown(rowOf("Api"), { button: 0 });
    await user.click(screen.getByRole("button", { name: "Purge" }));
    const dialog = await screen.findByRole("dialog", { name: "Purge" });
    expect(dialog).toHaveTextContent("/home/user/.claude/projects/-w-api");
    expect(dialog).toHaveTextContent("the record of claude-agent-api");
    expect(server.callsTo("boxes.purge").map((c) => c.body)).toEqual([{ dryRun: true }]);
    expect(server.state.boxes).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(server.callsTo("boxes.purge")).toHaveLength(2));
    expect(server.callsTo("boxes.purge")[1]?.body).toEqual({ dryRun: false });
    await waitFor(() => expect(server.state.boxes).toHaveLength(1));
  });

  it("previews Convert to Worktree with the server's plan", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({
      boxes: [
        makeBoxView({
          box: {
            id: "claude-agent-mail",
            targetDir: "/w/app",
            conversationName: "Mail",
            workspace: "Mail",
          },
          status: "stopped",
        }),
      ],
    });
    server.on("boxes.convertToWorktree.plan", () => ({
      report: "Mail/ becomes /w/app/.worktrees/Mail; 2 stashes carry over.",
      buildOutputBytes: 3 * 1024 * 1024,
    }));
    renderWithServer(<App />, server);
    await screen.findByRole("cell", { name: "Mail" });
    fireEvent.mouseDown(rowOf("Mail"), { button: 0 });
    fireEvent.contextMenu(rowOf("Mail"));
    await user.click(await screen.findByRole("menuitem", { name: "Convert to Worktree..." }));
    const dialog = await screen.findByRole("dialog", { name: "Convert to Worktree" });
    expect(dialog).toHaveTextContent("2 stashes carry over.");
    await user.click(within(dialog).getByLabelText("Also copy build output (3.0 MiB)"));
    await user.click(within(dialog).getByRole("button", { name: "Convert" }));
    await waitFor(() => expect(server.callsTo("boxes.convertToWorktree")).toHaveLength(1));
    expect(server.callsTo("boxes.convertToWorktree")[0]?.body).toEqual({ copyBuildOutput: true });
  });

  it("marks a box whose directory is missing", async () => {
    const list = boxes();
    list[1]!.targetDirExists = false;
    await renderApp(new FakeServer({ boxes: list }));
    expect(within(rowOf("Api")).getByText("[missing]")).toBeInTheDocument();
    expect(within(rowOf("Site work")).queryByText("[missing]")).toBeNull();
  });

  it("removes a stopped worktree box and asks about the worktree, defaulting to keep", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    fireEvent.mouseDown(rowOf("Api"), { button: 0 });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const first = await screen.findByRole("dialog", { name: "Remove" });
    expect(first).toHaveTextContent('Remove "claude-agent-api" from the dashboard?');
    await user.click(within(first).getByRole("button", { name: "Yes" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Remove" })).toHaveTextContent(
        "Also delete the git worktree",
      ),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(server.callsTo("boxes.remove")).toHaveLength(1));
    expect(server.callsTo("boxes.remove")[0]?.query).toEqual({ removeWorktree: false });
  });

  it("disables Remove for a running box and Stop for a stopped one", async () => {
    await renderApp(new FakeServer({ boxes: boxes() }));
    await waitFor(() => expect(rowOf("Site work")).toHaveAttribute("aria-selected", "true"));
    const toolbar = screen.getByRole("toolbar");
    expect(within(toolbar).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(within(toolbar).getByRole("button", { name: "Stop" })).toBeEnabled();
    fireEvent.mouseDown(rowOf("Api"), { button: 0 });
    expect(within(toolbar).getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(within(toolbar).getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("opens a terminal tab on double-click and reuses it", async () => {
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    fireEvent.doubleClick(rowOf("Site work"));
    fireEvent.doubleClick(rowOf("Site work"));
    const tabs = within(screen.getByRole("tablist", { name: "Terminals" })).getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveTextContent("Site work");
    expect(tabs[0]).toHaveAttribute("title", expect.stringContaining("claude-agent-site"));
    await waitFor(() => expect(server.socketsFor("/api/v1/terminals")).toHaveLength(1));
    expect(server.socketsFor("/api/v1/terminals")[0]?.query.get("boxId")).toBe("claude-agent-site");
  });

  it("marks a tab ended with its exit code, and Ctrl+Shift+W closes it", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    fireEvent.doubleClick(rowOf("Site work"));
    await waitFor(() => expect(server.socketsFor("/api/v1/terminals")).toHaveLength(1));
    act(() => server.socketsFor("/api/v1/terminals")[0]?.serverSend({ type: "exit", exitCode: 3 }));
    expect(await screen.findByText(/Site work \(ended\)/)).toBeInTheDocument();
    expect(screen.getByText(/Session ended \(exit 3\)\./)).toBeInTheDocument();
    await user.keyboard("{Control>}{Shift>}W{/Shift}{/Control}");
    expect(screen.queryByRole("tablist", { name: "Terminals" })).toBeNull();
  });

  it("starts a stopped box on double-click and opens its tab", async () => {
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    fireEvent.doubleClick(rowOf("Api"));
    await waitFor(() => expect(server.callsTo("boxes.start")).toHaveLength(1));
    expect(await screen.findByRole("tab", { name: /Api/ })).toBeInTheDocument();
  });

  it("offers to restart the container when a start finds stale mounts", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: boxes() });
    let first = true;
    server.on("boxes.start", (req, s) => {
      if (first) {
        first = false;
        throw new FakeApiError("stale_mounts", "The container's mounts changed.");
      }
      const v = s.box(req.params.boxId as string);
      v.status = "running";
      return v;
    });
    await renderApp(server);
    fireEvent.doubleClick(rowOf("Api"));
    const dialog = await screen.findByRole("dialog", { name: "Start" });
    await user.click(within(dialog).getByRole("button", { name: "Restart Container" }));
    await waitFor(() => expect(server.callsTo("boxes.start")).toHaveLength(2));
    expect(server.callsTo("projects.restartContainer")).toHaveLength(1);
    expect(server.callsTo("boxes.start")[1]?.body).toEqual({ force: false });
  });

  it("starts anyway with force when the mounts are stale", async () => {
    const user = userEvent.setup();
    const list = boxes();
    const server = new FakeServer({ boxes: list });
    server.state.staleProjects.push(list[1]!.box.projectId);
    await renderApp(server);
    fireEvent.doubleClick(rowOf("Api"));
    const dialog = await screen.findByRole("dialog", { name: "Start" });
    await user.click(within(dialog).getByRole("button", { name: "Start Anyway" }));
    await waitFor(() => expect(server.callsTo("boxes.start")).toHaveLength(2));
    expect(server.callsTo("boxes.start")[1]?.body).toEqual({ force: true });
    expect(server.callsTo("projects.restartContainer")).toHaveLength(0);
    expect(await screen.findByRole("tab", { name: /Api/ })).toBeInTheDocument();
  });

  it("asks to resume boxes that were running when nothing runs", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({
      boxes: [
        makeBoxView({
          box: { id: "claude-agent-a", targetDir: "/w/a", wasRunning: true },
          status: "stopped",
        }),
      ],
    });
    renderWithServer(<App />, server);
    const dialog = await screen.findByRole("dialog", { name: "Resume boxes?" });
    expect(dialog).toHaveTextContent("1 box was running before the last shutdown:");
    expect(within(dialog).getByRole("button", { name: "Rebuild Image..." })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(server.callsTo("boxes.startAll")).toHaveLength(1));
    expect(server.callsTo("boxes.startAll")[0]?.body).toEqual({ onlyWasRunning: true });
  });

  it("opens the setup wizard when setup isn't complete", async () => {
    renderWithServer(<App />, new FakeServer({ settings: { setupCompleted: false } }));
    expect(await screen.findByRole("dialog", { name: "Setup" })).toBeInTheDocument();
  });

  it("applies box.changed events from the stream", async () => {
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    await waitFor(() => expect(server.socketsFor("/api/v1/events")).toHaveLength(1));
    const api = server.state.boxes[1]?.box;
    act(() => {
      server.emit(
        makeEvent("box.changed", {
          boxId: "claude-agent-api",
          status: "running",
          box: { ...api!, conversationName: "Api v2" },
        }),
      );
    });
    expect(await screen.findByRole("cell", { name: "Api v2" })).toBeInTheDocument();
    expect(screen.getByText("2 running \u00b7 0 not running")).toBeInTheDocument();
  });

  it("keeps a box.changed that arrives while a reload is in flight", async () => {
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    await waitFor(() => expect(server.socketsFor("/api/v1/events")).toHaveLength(1));
    const stale = JSON.parse(JSON.stringify(server.state.boxes)) as typeof server.state.boxes;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // The first reload answers late with the old list; later ones never
    // answer, so the result shows only that reload and the replayed event.
    let calls = 0;
    server.on("boxes.list", async () => {
      calls += 1;
      if (calls > 1) await new Promise(() => undefined);
      await gate;
      return { boxes: stale };
    });
    // The server restarted: the app reloads through REST.
    const [ws] = server.socketsFor("/api/v1/events");
    await waitFor(() => expect(screen.getByText(/updated/)).toBeInTheDocument());
    const before = server.callsTo("boxes.list").length;
    act(() => {
      ws!.serverSend({ type: "hello", streamId: "restarted", lastSeq: 0, replaying: false });
    });
    await waitFor(() => expect(server.callsTo("boxes.list").length).toBe(before + 1));
    act(() => {
      ws!.serverSend({
        ...makeEvent("box.changed", {
          boxId: "claude-agent-api",
          status: "running",
          box: stale[1]!.box,
        }),
        streamId: "restarted",
        seq: 1,
      });
    });
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() =>
      expect(screen.getByText("2 running \u00b7 0 not running")).toBeInTheDocument(),
    );
  });

  it("shows dev-server links from ports.changed in the details panel", async () => {
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    await waitFor(() => expect(server.socketsFor("/api/v1/events")).toHaveLength(1));
    const site = server.state.boxes[0];
    act(() => {
      server.emit(
        makeEvent("ports.changed", {
          container: site!.container,
          listeners: [{ port: 5173, proto: "tcp", process: "node", boxId: "claude-agent-site" }],
        }),
      );
      server.emit(
        makeEvent("container.stats", {
          container: site!.container,
          projectId: site!.box.projectId,
          cpuPercent: 42,
          memBytes: 512 * 1024 * 1024,
          memLimitBytes: 2048 * 1024 * 1024,
          diskBytes: 1024,
        }),
      );
    });
    expect(
      await screen.findByRole("link", { name: "http://5173.site.localhost:20400/" }),
    ).toBeInTheDocument();
    expect(screen.getByText("42.0%")).toBeInTheDocument();
    expect(screen.getByText("512 MiB / 2.0 GiB")).toBeInTheDocument();
  });

  it("confirms adoption of a conversation a stopped box tracks, then retries with force", async () => {
    const user = userEvent.setup();
    const other = makeBoxView({
      box: {
        id: "claude-agent-old",
        targetDir: "/w/site",
        sessionUuid: "22222222-2222-4222-8222-222222222222",
      },
    });
    const server = new FakeServer({
      boxes: [...boxes(), other],
      conversations: {
        "/w/site": [
          {
            sessionUuid: "22222222-2222-4222-8222-222222222222",
            title: "Old work",
            titleSource: "custom-title",
            turns: 2,
            modifiedAt: "2026-10-28T08:00:00Z",
            sizeBytes: 1,
            lastPrompt: "",
            trackedBy: ["claude-agent-old"],
          },
        ],
      },
    });
    await renderApp(server);
    await waitFor(() => expect(rowOf("Site work")).toHaveAttribute("aria-selected", "true"));
    await user.keyboard("{Control>}{Shift>}E{/Shift}{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Edit Box" });
    await within(dialog).findByRole("option", { name: /Old work/ });
    await user.selectOptions(
      within(dialog).getByLabelText("Conversation"),
      "22222222-2222-4222-8222-222222222222",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText(/already tracks this conversation/)).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(server.callsTo("boxes.update")).toHaveLength(2));
    expect(server.callsTo("boxes.update")[1]?.body).toMatchObject({ force: true });
    // The box runs, so the relink needs a restart, and the app offers one.
    expect(await screen.findByText(/Restart it now to apply them\?/)).toBeInTheDocument();
  });

  it("creates a box as a job and opens its terminal", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: boxes() });
    await renderApp(server);
    await user.keyboard("{Control>}{Shift>}N{/Shift}{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "New Box" });
    await user.type(within(dialog).getByLabelText("Target directory"), "/w/new");
    await user.type(within(dialog).getByLabelText("Conversation name"), "Fresh start");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(server.callsTo("boxes.create")).toHaveLength(1));
    expect(server.callsTo("boxes.create")[0]?.body).toMatchObject({
      targetDir: "/w/new",
      conversationName: "Fresh start",
      layout: "root",
      rememberLayout: true,
      conversation: { mode: "new" },
    });
    expect(
      await screen.findByRole("tab", { name: /Fresh_start/ }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(server.contractViolations).toEqual([]);
  });

  it("shows a bar when the server is unreachable", async () => {
    const server = new FakeServer();
    server.on("projects.list", () => {
      throw new TypeError("refused");
    });
    renderWithServer(<App />, server);
    expect(await screen.findByText(/The Agent Box server is not reachable/)).toBeInTheDocument();
  });
});
