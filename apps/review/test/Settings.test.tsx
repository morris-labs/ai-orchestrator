import { defaultConfig } from "@agentbox/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Settings } from "../src/screens/Settings.js";
import { renderWithStore } from "./helpers/render.js";

describe("Settings", () => {
  it("patches only the changed ceiling and toggle", async () => {
    const settings = defaultConfig();
    const { server } = renderWithStore(<Settings />, {
      "settings.get": () => settings,
      "settings.patch": (c) => ({
        ...settings,
        ...(c.body as object),
        ceilings: { ...settings.ceilings, codex: { kind: "utilization", window: "5h", max: 0.5 } },
      }),
    });
    const codex = await screen.findByRole("group", { name: "Codex" });
    expect(within(codex).getByLabelText("Ceiling (%)")).toHaveValue(70);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(within(codex).getByLabelText("Ceiling (%)"), { target: { value: "50" } });
    fireEvent.click(screen.getByLabelText(/A round finished/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.callsTo("settings.patch")).toHaveLength(1));
    expect(server.callsTo("settings.patch")[0]!.body).toEqual({
      ceilings: { codex: { kind: "utilization", window: "5h", max: 0.5 } },
      notifications: { roundSummary: false },
    });
    expect(screen.getByText("Automatic model selection")).toBeInTheDocument();
  });

  it("switches Copilot's spend ceiling and follows settings.changed", async () => {
    const settings = defaultConfig();
    const { store } = renderWithStore(<Settings />, { "settings.get": () => settings });
    const copilot = await screen.findByRole("group", { name: "Copilot" });
    expect(within(copilot).getByLabelText("Ceiling (US dollars per month)")).toHaveValue(70);
    act(() =>
      store.ingest({
        id: "e",
        time: "2026-10-28T10:00:00.000Z",
        source: "server",
        streamId: "s",
        seq: 1,
        sourceSeq: 1,
        type: "settings.changed",
        settings: {
          ...settings,
          ceilings: {
            ...settings.ceilings,
            copilot: { kind: "spend", period: "month", maxUsd: 90 },
          },
        },
        changedKeys: ["ceilings"],
      }),
    );
    expect(
      within(screen.getByRole("group", { name: "Copilot" })).getByLabelText(
        "Ceiling (US dollars per month)",
      ),
    ).toHaveValue(90);
  });
});
