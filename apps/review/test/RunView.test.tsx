import type { Decision, Finding, RunState } from "@aio/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DecisionPanel, RunList, RunView, StageStepper } from "../src/screens/RunView.js";
import { RUN_ID, demoFindings, demoRounds, lastRun, loadDemoEvents } from "./helpers/data.js";
import { renderWithStore } from "./helpers/render.js";

const findings = demoFindings();
const byId = (id: string) => findings.find((f) => f.id === id)!;

function handlers(run: RunState = lastRun()) {
  return {
    "runs.get": () => run,
    "runs.rounds": () => ({ rounds: demoRounds() }),
    "findings.get": (c: { params: Record<string, string> }) => ({
      finding: byId(c.params.findingId!),
      diff: "@@ -1 +1 @@\n-a\n+b",
      fixDiff: null,
    }),
    "findings.list": () => ({ findings }),
    "runs.decide": (c: { body: unknown }) => ({
      ...run,
      status: "running",
      decision: null,
      body: c.body,
    }),
    "runs.pause": () => ({ ...run, status: "paused" }),
    "runs.assign": () => run,
    "runs.profile": (c: { body: unknown }) => ({
      ...run,
      profile: (c.body as { profile: RunState["profile"] }).profile,
    }),
  };
}

describe("StageStepper", () => {
  it.each([
    ["find", "running", "find", "current"],
    ["merge", "waiting_decision", "merge", "blocked"],
    ["fix", "paused", "fix", "paused"],
    ["gate", "failed", "gate", "failed"],
  ] as const)("marks %s as %s", (stage, status, label, state) => {
    const run = lastRun();
    render(<StageStepper run={{ ...run, stage, status }} />);
    expect(screen.getByText(label).closest("li")).toHaveAttribute("data-state", state);
  });
});

describe("DecisionPanel", () => {
  const kinds: Array<[Decision["kind"], Decision["options"], string[]]> = [
    [
      "oscillation",
      ["resume", "resume_waive", "cancel"],
      ["Resume", "Resume and waive these findings", "Cancel the run"],
    ],
    ["round_cap", ["resume", "cancel"], ["Resume", "Cancel the run"]],
    ["ceiling", ["resume", "cancel"], ["Resume", "Cancel the run"]],
    [
      "gate_failed",
      ["resume_waive", "cancel"],
      ["Resume and waive these findings", "Cancel the run"],
    ],
    ["push_blocked", ["cancel"], ["Cancel the run"]],
  ];
  it.each(kinds)("%s shows its buttons", (kind, options, labels) => {
    render(
      <DecisionPanel
        decision={{ kind, options, findingIds: ["F-0007"], message: "Why it stopped." }}
        findings={[byId("F-0007")]}
        onDecide={() => undefined}
      />,
    );
    const region = screen.getByRole("region", { name: "Decision needed" });
    expect(
      within(region)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(labels);
    expect(within(region).getByText("Why it stopped.")).toBeInTheDocument();
  });

  it("shows both versions for an oscillation and needs a reason to waive", () => {
    const onDecide = vi.fn();
    render(
      <DecisionPanel
        decision={{
          kind: "oscillation",
          options: ["resume", "resume_waive", "cancel"],
          findingIds: ["F-0007"],
          message: "",
        }}
        findings={[byId("F-0001"), byId("F-0007")] as Finding[]}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByText("Before: closed by a fix")).toBeInTheDocument();
    expect(screen.getByText("Now: raised again")).toBeInTheDocument();
    const waive = screen.getByRole("button", { name: "Resume and waive these findings" });
    expect(waive).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason for waiving"), {
      target: { value: "Accepted for now" },
    });
    fireEvent.click(waive);
    expect(onDecide).toHaveBeenCalledWith("resume_waive", "Accepted for now");
  });
});

describe("RunView", () => {
  it("loads the run, shows the oscillation, and answers the decision", async () => {
    const { server } = renderWithStore(<RunView runId={RUN_ID} />, handlers());
    expect(await screen.findByText(/Needs your decision/)).toBeInTheDocument();
    expect(screen.getByLabelText("Round")).toHaveTextContent("2 of 25");
    await screen.findByText("Before: closed by a fix");
    expect(screen.getAllByText(/Retry loop never gives up/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(server.callsTo("runs.decide")).toHaveLength(1));
    expect(server.callsTo("runs.decide")[0]!.body).toEqual({
      option: "resume",
      waiveFindingIds: [],
      reason: undefined,
    });
    await screen.findByText(/Running/);
  });

  it("leaves the fixed finding of an oscillation out of Resume and waive", async () => {
    const base = lastRun();
    const returned = base.decision!.findingIds[0]!;
    const fixed = findings.find((f) => f.id !== returned)!.id;
    // An oscillation names the fixed finding and the one that came back.
    const run = { ...base, decision: { ...base.decision!, findingIds: [fixed, returned] } };
    const { server } = renderWithStore(<RunView runId={RUN_ID} />, handlers(run));
    expect(await screen.findByText(/Needs your decision/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason for waiving"), {
      target: { value: "Accepted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume and waive these findings" }));
    await waitFor(() => expect(server.callsTo("runs.decide")).toHaveLength(1));
    const body = server.callsTo("runs.decide")[0]!.body as {
      option: string;
      waiveFindingIds: string[];
    };
    expect(body.option).toBe("resume_waive");
    expect(body.waiveFindingIds).toEqual([]);
  });

  it("shows the round table, roles, and the run's agents from the stream", async () => {
    const { store } = renderWithStore(<RunView runId={RUN_ID} />, handlers());
    await screen.findByText("Round summaries");
    act(() => {
      for (const e of loadDemoEvents()) store.ingest(e);
    });
    const table = screen.getByRole("table", { name: "Roles" });
    expect(within(table).getByRole("checkbox", { name: "reviewer: Copilot" })).toBeChecked();
    expect(within(table).getByRole("radio", { name: "fixer: Claude" })).toBeChecked();
    expect(screen.getByText("5 / 2 / 1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agents in this run" })).toBeInTheDocument();
    expect(screen.getByText("$0.75 so far this round")).toBeInTheDocument();
  });

  it("assigns a role and switches the profile", async () => {
    const { server } = renderWithStore(<RunView runId={RUN_ID} />, handlers());
    const table = await screen.findByRole("table", { name: "Roles" });
    fireEvent.click(within(table).getByRole("radio", { name: "disprover: Claude" }));
    const row = within(table).getByRole("radio", { name: "disprover: Claude" }).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Assign" }));
    await waitFor(() =>
      expect(server.callsTo("runs.assign")[0]?.body).toEqual({
        role: "disprover",
        vendors: ["claude"],
      }),
    );
    fireEvent.change(screen.getByLabelText("Profile"), { target: { value: "fast" } });
    await waitFor(() =>
      expect(server.callsTo("runs.profile")[0]?.body).toEqual({ profile: "fast" }),
    );
  });

  it("follows run.changed events for this run", async () => {
    const run = { ...lastRun(), status: "running" as const, decision: null };
    const { store } = renderWithStore(<RunView runId={RUN_ID} />, handlers(run));
    await screen.findByRole("button", { name: "Pause" });
    const ev = loadDemoEvents().find((e) => e.type === "run.changed")!;
    act(() => store.ingest({ ...ev, run: { ...run, status: "paused" } } as typeof ev));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("keeps a newer event's state when an older REST response arrives late", async () => {
    const run = { ...lastRun(), status: "running" as const, decision: null };
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { store, server } = renderWithStore(<RunView runId={RUN_ID} />, {
      ...handlers(run),
      "runs.get": async () => {
        await gate;
        return run;
      },
    });
    await waitFor(() => expect(server.callsTo("runs.get")).toHaveLength(1));
    const later = new Date(Date.parse(run.updatedAt) + 60_000).toISOString();
    const ev = loadDemoEvents().find((e) => e.type === "run.changed")!;
    act(() =>
      store.ingest({
        ...ev,
        run: { ...run, status: "paused", updatedAt: later },
      } as typeof ev),
    );
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    release();
    await new Promise((res) => setTimeout(res, 20));
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("keeps a stage.changed stage when a reload returns the same updatedAt", async () => {
    const run = {
      ...lastRun(),
      status: "running" as const,
      decision: null,
      stage: "find" as const,
    };
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { store, server } = renderWithStore(<RunView runId={RUN_ID} />, {
      ...handlers(run),
      "runs.get": async () => {
        calls += 1;
        if (calls > 1) await gate;
        return run;
      },
    });
    await screen.findByRole("button", { name: "Pause" });
    store.start();
    const hello = (streamId: string) =>
      act(() => {
        server
          .socketsFor("/api/v1/events")[0]!
          .serverSend({ type: "hello", streamId, lastSeq: 0, replaying: false });
      });
    await waitFor(() => expect(server.socketsFor("/api/v1/events")).toHaveLength(1));
    hello("first");
    hello("second");
    // The reset reloads the run; that request waits at the gate.
    await waitFor(() => expect(calls).toBe(2));
    const base = loadDemoEvents().find((e) => e.type === "stage.changed")!;
    act(() =>
      store.ingest({
        ...base,
        runId: RUN_ID,
        stage: "fix",
        previousStage: "find",
        time: run.updatedAt,
      } as typeof base),
    );
    expect(screen.getByText("fix").closest("li")).toHaveAttribute("data-state", "current");
    release();
    await new Promise((res) => setTimeout(res, 20));
    expect(screen.getByText("fix").closest("li")).toHaveAttribute("data-state", "current");
    store.stop();
  });
});

describe("RunList", () => {
  it("keeps a run created while the list loads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { store, server } = renderWithStore(<RunList />, {
      "runs.list": async () => {
        await gate;
        return { runs: [] };
      },
    });
    await waitFor(() => expect(server.callsTo("runs.list")).toHaveLength(1));
    const ev = loadDemoEvents().find((e) => e.type === "run.changed")!;
    act(() => store.ingest(ev));
    release();
    await new Promise((res) => setTimeout(res, 20));
    expect(screen.queryByText(/No runs yet/)).toBeNull();
    expect(screen.getByRole("link", { name: ev.run.id.slice(-6) })).toBeInTheDocument();
  });
});
