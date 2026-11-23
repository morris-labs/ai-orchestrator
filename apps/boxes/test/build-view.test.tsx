// The build view: a build's messages as a conversation with filters, its
// direct messages, its milestone board, and its usage, against the fake server.
import type { BuildSummary, BuildUsage, Message } from "@aio/contracts";
import { FakeServer, emptyBuildUsage, makeBuild, makeMessage } from "@aio/ui/testing";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BuildView } from "../src/components/BuildView";
import { renderWithServer } from "./helpers";

const B1 = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const build = makeBuild({ id: B1, slug: "add-export" });

const dev = (taskId: string) => ({ kind: "seat" as const, seat: "developer", taskId });
const pm = { kind: "seat" as const, seat: "project-manager", taskId: null };
const tester = (taskId: string) => ({ kind: "seat" as const, seat: "test-engineer", taskId });
const owner = { kind: "owner" as const };

/** A conversation over two tasks in two milestones. */
const conversation: Message[] = [
  makeMessage({ id: "M1", buildId: B1, from: dev("T1"), to: pm, taskId: "T1", body: "T1 asks PM" }),
  makeMessage({
    id: "M2",
    buildId: B1,
    from: pm,
    to: dev("T1"),
    type: "answer",
    taskId: "T1",
    body: "PM answers T1",
  }),
  makeMessage({
    id: "M3",
    buildId: B1,
    from: dev("T2"),
    to: tester("T2"),
    type: "test_dispute",
    taskId: "T2",
    body: "T2 disputes a test",
  }),
  makeMessage({
    id: "M4",
    buildId: B1,
    from: tester("T2"),
    to: dev("T2"),
    type: "answer",
    taskId: "T2",
    body: "Tester answers T2",
  }),
  makeMessage({
    id: "M5",
    buildId: B1,
    from: pm,
    to: dev("T2"),
    type: "note",
    taskId: null,
    milestone: "search",
    body: "PM notes the search milestone",
  }),
  makeMessage({
    id: "M6",
    buildId: B1,
    from: dev("T1"),
    to: owner,
    routing: "addressed",
    type: "note",
    taskId: "T1",
    body: "T1 tells the owner",
  }),
];

function serverWith(messages: Message[] = conversation) {
  const server = new FakeServer({ builds: [build] });
  server.state.buildMessages[B1] = [...messages];
  server.state.buildTasks[B1] = [
    { taskId: "T1", status: "done", milestone: "export", updatedAt: "2026-10-28T09:00:00Z" },
    { taskId: "T2", status: "running", milestone: "search", updatedAt: "2026-10-28T09:00:00Z" },
  ];
  return server;
}

async function renderView(server: FakeServer) {
  const utils = renderWithServer(<BuildView build={build} />, server);
  await screen.findByRole("list", { name: "Messages" });
  return utils;
}

/** The bodies of the messages the conversation shows, in order. */
const shown = () =>
  within(screen.getByRole("list", { name: "Messages" }))
    .queryAllByRole("listitem")
    .map((li) => li.querySelector(".bx-message-body")?.textContent);

describe("build view messages", () => {
  it("shows the build's messages as a conversation, oldest first", async () => {
    await renderView(serverWith());
    expect(shown()).toEqual([
      "T1 asks PM",
      "PM answers T1",
      "T2 disputes a test",
      "Tester answers T2",
      "PM notes the search milestone",
      "T1 tells the owner",
    ]);
    const first = within(screen.getByRole("list", { name: "Messages" })).getAllByRole(
      "listitem",
    )[0] as HTMLElement;
    expect(first).toHaveTextContent("developer (T1) to project-manager");
  });

  it("narrows the conversation by task, by milestone, and by seat", async () => {
    const user = userEvent.setup();
    await renderView(serverWith());
    await user.selectOptions(screen.getByRole("combobox", { name: "Task" }), "T2");
    expect(shown()).toEqual(["T2 disputes a test", "Tester answers T2"]);

    await user.selectOptions(screen.getByRole("combobox", { name: "Task" }), "");
    // A milestone covers the messages about it and the messages about its tasks.
    await user.selectOptions(screen.getByRole("combobox", { name: "Milestone" }), "search");
    expect(shown()).toEqual([
      "T2 disputes a test",
      "Tester answers T2",
      "PM notes the search milestone",
    ]);

    await user.selectOptions(screen.getByRole("combobox", { name: "Milestone" }), "");
    // A seat covers the messages it sent and the messages it received.
    await user.selectOptions(screen.getByRole("combobox", { name: "Seat" }), "test-engineer");
    expect(shown()).toEqual(["T2 disputes a test", "Tester answers T2"]);
  });

  it("combines the filters", async () => {
    const user = userEvent.setup();
    await renderView(serverWith());
    await user.selectOptions(screen.getByRole("combobox", { name: "Seat" }), "project-manager");
    expect(shown()).toEqual(["T1 asks PM", "PM answers T1", "PM notes the search milestone"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Milestone" }), "export");
    expect(shown()).toEqual(["T1 asks PM", "PM answers T1"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Task" }), "T2");
    expect(shown()).toEqual([]);
    expect(screen.getByText("No messages match the filters.")).toBeInTheDocument();
  });

  it("shows exactly the messages one agent received as its slice", async () => {
    const user = userEvent.setup();
    await renderView(serverWith());
    const slice = screen.getByRole("combobox", { name: "Slice" });
    // Every agent that received a message has a slice, the owner included.
    expect(
      within(slice)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Everyone",
      "developer (T1)",
      "developer (T2)",
      "owner",
      "project-manager",
      "test-engineer (T2)",
    ]);
    await user.selectOptions(slice, "developer (T2)");
    // Not the messages the agent sent, and not those of the Developer of T1.
    expect(shown()).toEqual(["Tester answers T2", "PM notes the search milestone"]);
    await user.selectOptions(slice, "project-manager");
    expect(shown()).toEqual(["T1 asks PM"]);
  });

  it("lists the direct messages to the owner on their own", async () => {
    await renderView(serverWith());
    const direct = screen.getByRole("list", { name: "Direct messages" });
    expect(within(direct).getAllByRole("listitem")).toHaveLength(1);
    expect(direct).toHaveTextContent("T1 tells the owner");
  });

  it("adds messages from the event stream without a reload", async () => {
    const server = serverWith();
    await renderView(server);
    const loads = server.callsTo("builds.messages").length;
    act(() => {
      server.putMessages([
        makeMessage({ id: "M7", buildId: B1, body: "A late question" }),
        makeMessage({ id: "M1", buildId: "01JB8Z5K3W6Q2V9X4T7R0M1N2Z", body: "Another build" }),
      ]);
    });
    await waitFor(() => expect(shown().at(-1)).toBe("A late question"));
    expect(shown()).not.toContain("Another build");
    expect(server.callsTo("builds.messages").length).toBe(loads);
  });

  it("stays responsive with thousands of messages", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 5000 }, (_, i) =>
      makeMessage({
        id: `M${i + 1}`,
        buildId: B1,
        from: dev(i % 2 === 0 ? "T1" : "T2"),
        taskId: i % 2 === 0 ? "T1" : "T2",
        body: `Message number ${i + 1}`,
      }),
    );
    const started = performance.now();
    await renderView(serverWith(many));
    // The view renders a window of the newest messages, not all 5000.
    expect(shown().length).toBeLessThanOrEqual(200);
    expect(shown().at(-1)).toBe("Message number 5000");
    expect(screen.getByText("Showing 200 of 5000 messages.")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Task" }), "T2");
    expect(shown().at(-1)).toBe("Message number 5000");
    expect(screen.getByText("Showing 200 of 2500 messages.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show earlier messages" }));
    expect(shown().length).toBe(400);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe("build view board and usage", () => {
  it("shows each milestone's tasks with their state and updates from the event stream", async () => {
    const server = serverWith();
    await renderView(server);
    const board = await screen.findByRole("region", { name: "Milestone board" });
    const column = (name: string) => within(board).getByRole("list", { name });
    await waitFor(() => expect(column("export")).toHaveTextContent("T1Done"));
    expect(column("search")).toHaveTextContent("T2Running");
    act(() => {
      server.putTask(B1, { taskId: "T2", status: "failed" }, "2026-10-28T10:00:00Z");
      server.putTask(B1, { taskId: "T3", status: "pending", milestone: "search" });
      server.putTask(B1, { taskId: "T4", status: "pending" });
    });
    await waitFor(() => expect(column("search")).toHaveTextContent("T2Failed"));
    expect(column("search")).toHaveTextContent("T3Pending");
    expect(column("No milestone")).toHaveTextContent("T4Pending");
  });

  it("shows the usage by seat and by specialty and refreshes it when a call settles", async () => {
    const server = serverWith();
    await renderView(server);
    const bySeat = await screen.findByRole("table", { name: "Usage by seat" });
    expect(within(bySeat).getByText("No settled calls yet.")).toBeInTheDocument();
    const totals = { calls: 2, tokensIn: 1200, tokensOut: 300, premiumRequests: 0 };
    const usage: BuildUsage = {
      ...emptyBuildUsage(B1),
      total: { ...totals, costEstimate: 0.5 },
      bySeat: [{ seat: "developer", ...totals, costEstimate: 0.5 }],
      bySpecialty: [{ specialty: "python-dev", ...totals, costEstimate: 0.5 }],
    };
    act(() => server.putBuildUsage(usage));
    await waitFor(() =>
      expect(
        within(screen.getByRole("table", { name: "Usage by seat" })).getByText("developer"),
      ).toBeInTheDocument(),
    );
    const row = within(screen.getByRole("table", { name: "Usage by seat" }))
      .getByText("developer")
      .closest("tr") as HTMLElement;
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["developer", "2", "1,200", "300", "$0.50"]);
    expect(
      within(screen.getByRole("table", { name: "Usage by specialty" })).getByText("python-dev"),
    ).toBeInTheDocument();
  });

  it("marks the Project manager's transcript usage as tokens only and refreshes it from its event", async () => {
    const server = serverWith();
    await renderView(server);
    await screen.findByRole("table", { name: "Usage by seat" });
    const pm = { seat: "project-manager", premiumRequests: 0, costEstimate: 0, tokensOnly: true };
    server.state.buildUsage[B1] = {
      ...emptyBuildUsage(B1),
      bySeat: [{ ...pm, calls: 5, tokensIn: 9000, tokensOut: 400 }],
    };
    act(() => {
      server.emit({
        type: "build.seat.usage",
        id: "seat-usage-1",
        time: "2026-10-28T09:00:00.000Z",
        source: "server",
        streamId: "s",
        seq: 0,
        sourceSeq: 0,
        buildId: B1,
        seat: "project-manager",
        turns: 5,
        tokensIn: 9000,
        tokensOut: 400,
        since: "2026-10-28T09:00:00.000Z",
        through: "2026-10-28T09:00:00.000Z",
      });
    });
    const table = screen.getByRole("table", { name: "Usage by seat" });
    await waitFor(() => expect(within(table).getByText("project-manager")).toBeInTheDocument());
    const row = within(table).getByText("project-manager").closest("tr") as HTMLElement;
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["project-manager", "5 turns", "9,000", "400", "Tokens only"]);
  });
});

describe("build view controls", () => {
  const confirmYes = async (title: string) =>
    within(await screen.findByRole("dialog", { name: title })).getByRole("button", {
      name: "Yes",
    });

  async function renderControls(status: BuildSummary["status"]) {
    const current = { ...build, status };
    const server = new FakeServer({ builds: [current] });
    renderWithServer(<BuildView build={current} />, server);
    const controls = await screen.findByRole("group", { name: "Build controls" });
    return { server, controls };
  }

  it("pauses a running build and cancels it after a confirmation", async () => {
    const { server, controls } = await renderControls("running");
    expect(within(controls).queryByRole("button", { name: "Resume" })).toBeNull();
    expect(within(controls).queryByRole("button", { name: "Delete build" })).toBeNull();

    await userEvent.click(within(controls).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(server.callsTo("builds.pause")).toHaveLength(1));

    await userEvent.click(within(controls).getByRole("button", { name: "Cancel build" }));
    await userEvent.click(await confirmYes("Cancel Build"));
    await waitFor(() => expect(server.callsTo("builds.cancel")).toHaveLength(1));
    expect(server.callsTo("builds.cancel")[0]?.params).toMatchObject({ buildId: B1 });
  });

  it("resumes or deletes a cancelled build, and deletes only after a confirmation", async () => {
    const { server, controls } = await renderControls("cancelled");
    expect(within(controls).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(within(controls).queryByRole("button", { name: "Cancel build" })).toBeNull();

    await userEvent.click(within(controls).getByRole("button", { name: "Delete build" }));
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Delete Build" })).getByRole("button", {
        name: "No",
      }),
    );
    expect(server.callsTo("builds.delete")).toHaveLength(0);
    await userEvent.click(within(controls).getByRole("button", { name: "Delete build" }));
    await userEvent.click(await confirmYes("Delete Build"));
    await waitFor(() => expect(server.callsTo("builds.delete")).toHaveLength(1));

    await userEvent.click(within(controls).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(server.callsTo("builds.resume")).toHaveLength(1));
  });

  it("shows why the engine refused a request", async () => {
    const { server, controls } = await renderControls("paused");
    const stored = server.state.builds[0];
    if (stored) stored.status = "finished";
    await userEvent.click(within(controls).getByRole("button", { name: "Resume" }));
    expect(await within(controls).findByRole("alert")).toHaveTextContent(
      "Couldn't resume the build",
    );
  });
});

describe("build view post box", () => {
  const postBox = () => screen.getByRole("form", { name: "Post to an agent" });

  it("posts to an agent, which shows the post in the conversation", async () => {
    const user = userEvent.setup();
    const server = serverWith();
    await renderView(server);
    const form = postBox();
    await user.selectOptions(within(form).getByRole("combobox", { name: "To" }), "developer (T2)");
    await user.type(within(form).getByRole("textbox", { name: "Post" }), "Keep the old column.");
    await user.click(within(form).getByRole("button", { name: "Post" }));
    await waitFor(() => expect(shown().at(-1)).toBe("Keep the old column."));
    expect(server.callsTo("builds.post")[0]?.body).toEqual({
      to: "developer",
      toTask: "T2",
      type: "note",
      body: "Keep the old column.",
    });
    expect(within(form).getByRole("textbox", { name: "Post" })).toHaveValue("");
    expect(within(form).getByRole("status")).toHaveTextContent("Posted to developer (T2).");
  });

  it("asks what a post to an agent without a task is about", async () => {
    const user = userEvent.setup();
    const server = serverWith();
    await renderView(server);
    const form = postBox();
    await user.selectOptions(within(form).getByRole("combobox", { name: "To" }), "project-manager");
    await user.type(within(form).getByRole("textbox", { name: "Post" }), "Split the export.");
    expect(within(form).getByRole("button", { name: "Post" })).toBeDisabled();
    await user.selectOptions(
      within(form).getByRole("combobox", { name: "About" }),
      "Milestone export",
    );
    await user.click(within(form).getByRole("button", { name: "Post" }));
    await waitFor(() => expect(shown().at(-1)).toBe("Split the export."));
    expect(server.callsTo("builds.post")[0]?.body).toMatchObject({
      to: "project-manager",
      milestone: "export",
    });
  });

  it("tells the owner that a post for a meeting seat went into the meeting", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ builds: [{ ...build, status: "planning", step: "planning" }] });
    server.state.buildMeetings[B1] = {
      version: 1,
      id: "meeting-1",
      proposer: "architect",
      members: ["critic"],
      brief: "Settle the design.",
      roundCap: 3,
      status: "running",
      rounds: [],
      posts: [],
      open: [],
      startedAt: "2026-10-28T09:00:00Z",
    };
    renderWithServer(
      <BuildView build={{ ...build, status: "planning", step: "planning" }} />,
      server,
    );
    const form = await screen.findByRole("form", { name: "Post to an agent" });
    await user.selectOptions(within(form).getByRole("combobox", { name: "To" }), "critic");
    await user.type(within(form).getByRole("textbox", { name: "Post" }), "Weigh the cost.");
    await user.click(within(form).getByRole("button", { name: "Post" }));
    expect(await within(form).findByRole("status")).toHaveTextContent(
      "Posted to the planning meeting meeting-1.",
    );
    expect(server.state.buildMeetings[B1]?.posts.map((p) => p.body)).toEqual(["Weigh the cost."]);
  });

  it("shows why the engine refused a post", async () => {
    const user = userEvent.setup();
    const server = serverWith();
    await renderView(server);
    server.state.builds = [];
    const form = postBox();
    await user.selectOptions(within(form).getByRole("combobox", { name: "To" }), "developer (T1)");
    await user.type(within(form).getByRole("textbox", { name: "Post" }), "Hello.");
    await user.click(within(form).getByRole("button", { name: "Post" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Couldn't post");
    expect(within(form).getByRole("textbox", { name: "Post" })).toHaveValue("Hello.");
  });

  it("offers no post box for a build that ended", async () => {
    const server = new FakeServer({ builds: [{ ...build, status: "finished" }] });
    renderWithServer(<BuildView build={{ ...build, status: "finished" }} />, server);
    await screen.findByRole("list", { name: "Messages" });
    expect(screen.queryByRole("form", { name: "Post to an agent" })).toBeNull();
  });
});
