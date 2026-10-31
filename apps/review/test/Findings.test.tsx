import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Findings } from "../src/screens/Findings.js";
import { RUN_ID, demoFindings, lastRun, loadDemoEvents } from "./helpers/data.js";
import { renderWithStore } from "./helpers/render.js";
import { StoreProvider } from "../src/state/store.js";

const findings = demoFindings();
const run = { ...lastRun(), prUrl: "https://github.com/octo/app/pull/12", prNumber: 12 };

function handlers() {
  return {
    "runs.list": () => ({ runs: [run] }),
    "findings.list": () => ({ findings }),
    "findings.get": (c: { params: Record<string, string> }) => ({
      finding: findings.find((f) => f.id === c.params.findingId)!,
      diff: "--- a/src/mail/send.ts\n+++ b/src/mail/send.ts\n@@ -10,3 +10,3 @@\n-  retry();\n+  retry(limit);",
      fixDiff: "@@ -1 +1 @@\n+  if (attempts > 3) throw err;",
    }),
    "findings.waive": (c: { params: Record<string, string> }) => ({
      ...findings.find((f) => f.id === c.params.findingId)!,
      verdict: "waived",
    }),
  };
}

describe("Findings", () => {
  it("filters by vendor, severity, round, and verdict", async () => {
    renderWithStore(<Findings runId={RUN_ID} findingId={null} />, handlers());
    expect(await screen.findByText("6 of 6 findings")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: "copilot" } });
    expect(screen.getByText("3 of 6 findings")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "P1" } });
    expect(screen.getByText("1 of 6 findings")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Round"), { target: { value: "2" } });
    expect(screen.getByText("1 of 6 findings")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Verdict"), { target: { value: "pending" } });
    expect(screen.getByText("2 of 6 findings")).toBeInTheDocument();
  });

  it("shows the detail with diff, trail, evidence, and fix commit link", async () => {
    renderWithStore(<Findings runId={RUN_ID} findingId="F-0001" />, handlers());
    const detail = await screen.findByRole("article", { name: "Finding F-0001" });
    expect(within(detail).getByLabelText("Finding diff")).toHaveTextContent(/\+ retry\(limit\);/);
    expect(within(detail).getByLabelText("Fix diff")).toBeInTheDocument();
    expect(within(detail).getByText(/repro.sh exits 124/)).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: "b7c8d9e0f1" })).toHaveAttribute(
      "href",
      "https://github.com/octo/app/commit/b7c8d9e0f1a2",
    );
    const trail = detail.querySelector("ol.trail")!;
    expect(within(trail as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
    expect(within(detail).queryByRole("button", { name: "Waive" })).toBeNull();
    expect(within(detail).getByText("Symbol").nextSibling).toHaveTextContent("sendWithRetry");
  });

  it("waives a pending finding with a reason", async () => {
    const { server } = renderWithStore(<Findings runId={RUN_ID} findingId="F-0007" />, handlers());
    const detail = await screen.findByRole("article", { name: "Finding F-0007" });
    expect(within(detail).queryByText("Symbol")).toBeNull();
    fireEvent.change(within(detail).getByLabelText("Reason for waiving"), {
      target: { value: "Tracked in a ticket" },
    });
    fireEvent.click(within(detail).getByRole("button", { name: "Waive" }));
    await waitFor(() =>
      expect(server.callsTo("findings.waive")[0]?.body).toEqual({ reason: "Tracked in a ticket" }),
    );
    await waitFor(() => expect(within(detail).queryByRole("button", { name: "Waive" })).toBeNull());
  });

  it("adds findings that arrive on the stream", async () => {
    const { store } = renderWithStore(<Findings runId={RUN_ID} findingId={null} />, {
      ...handlers(),
      "findings.list": () => ({ findings: [] }),
    });
    await screen.findByText("0 of 0 findings");
    act(() => {
      for (const e of loadDemoEvents()) store.ingest(e);
    });
    expect(screen.getByText("6 of 6 findings")).toBeInTheDocument();
  });
});

describe("Findings with out-of-order responses", () => {
  const OTHER_RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";

  function gate() {
    let release!: () => void;
    const wait = new Promise<void>((res) => (release = res));
    return { wait, release };
  }

  function show(r: ReturnType<typeof renderWithStore>, ui: React.ReactElement) {
    r.rerender(<StoreProvider store={r.store}>{ui}</StoreProvider>);
  }

  it("keeps the detail and Waive on the finding the user selected last", async () => {
    const slow = gate();
    const base = handlers();
    const r = renderWithStore(<Findings runId={RUN_ID} findingId="F-0001" />, {
      ...base,
      "findings.get": async (c: { params: Record<string, string> }) => {
        if (c.params.findingId === "F-0001") await slow.wait;
        return base["findings.get"](c);
      },
    });
    show(r, <Findings runId={RUN_ID} findingId="F-0007" />);
    await screen.findByRole("article", { name: "Finding F-0007" });
    slow.release();
    await new Promise((res) => setTimeout(res, 20));
    const detail = screen.getByRole("article", { name: "Finding F-0007" });
    fireEvent.change(within(detail).getByLabelText("Reason for waiving"), {
      target: { value: "SYNTHETIC reason" },
    });
    fireEvent.click(within(detail).getByRole("button", { name: "Waive" }));
    await waitFor(() => expect(r.server.callsTo("findings.waive")).toHaveLength(1));
    expect(r.server.callsTo("findings.waive")[0]!.params.findingId).toBe("F-0007");
  });

  it("ignores a late findings list for a run the user left", async () => {
    const slow = gate();
    const r = renderWithStore(<Findings runId={RUN_ID} findingId={null} />, {
      ...handlers(),
      "runs.list": () => ({ runs: [run, { ...run, id: OTHER_RUN }] }),
      "findings.list": async (c: { params: Record<string, string> }) => {
        if (c.params.runId === RUN_ID) {
          await slow.wait;
          return { findings };
        }
        return { findings: [] };
      },
    });
    show(r, <Findings runId={OTHER_RUN} findingId={null} />);
    await waitFor(() => expect(r.server.callsTo("findings.list")).toHaveLength(2));
    slow.release();
    await new Promise((res) => setTimeout(res, 20));
    expect(screen.getByText("0 of 0 findings")).toBeInTheDocument();
  });

  it("keeps a verdict that changes while the findings list loads", async () => {
    const slow = gate();
    const r = renderWithStore(<Findings runId={RUN_ID} findingId={null} />, {
      ...handlers(),
      "findings.list": async () => {
        await slow.wait;
        return { findings };
      },
    });
    await waitFor(() => expect(r.server.callsTo("findings.list")).toHaveLength(1));
    const pending = findings.find((f) => f.verdict === "pending")!;
    const ev = loadDemoEvents().find((e) => e.type === "finding.changed")!;
    act(() =>
      r.store.ingest({
        ...ev,
        runId: RUN_ID,
        finding: { ...pending, verdict: "fixed" },
      } as typeof ev),
    );
    slow.release();
    await screen.findByText("6 of 6 findings");
    fireEvent.change(screen.getByLabelText("Verdict"), { target: { value: "pending" } });
    // Three are pending in the list; the event fixed one of them.
    expect(screen.getByText("2 of 6 findings")).toBeInTheDocument();
  });

  it("follows finding.changed in an open detail and drops Waive for a fixed finding", async () => {
    const { store } = renderWithStore(<Findings runId={RUN_ID} findingId="F-0007" />, handlers());
    const detail = await screen.findByRole("article", { name: "Finding F-0007" });
    expect(within(detail).getByRole("button", { name: "Waive" })).toBeInTheDocument();
    const ev = loadDemoEvents().find((e) => e.type === "finding.changed")!;
    act(() =>
      store.ingest({
        ...ev,
        runId: RUN_ID,
        finding: { ...findings.find((f) => f.id === "F-0007")!, verdict: "fixed" },
      } as typeof ev),
    );
    expect(within(detail).queryByRole("button", { name: "Waive" })).toBeNull();
  });
});
