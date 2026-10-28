import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Findings } from "../src/screens/Findings.js";
import { RUN_ID, demoFindings, lastRun } from "./helpers/data.js";
import { renderWithStore } from "./helpers/render.js";
import { loadDemoEvents } from "./helpers/stream.js";

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
  });

  it("waives a pending finding with a reason", async () => {
    const { server } = renderWithStore(<Findings runId={RUN_ID} findingId="F-0007" />, handlers());
    const detail = await screen.findByRole("article", { name: "Finding F-0007" });
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
