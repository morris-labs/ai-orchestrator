import { defaultConfig } from "@aio/contracts";
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
    expect(
      within(screen.getByRole("group", { name: "Copilot defaults" })).getByLabelText(/^Model/),
    ).toHaveValue("auto");
  });

  it("takes a fractional percentage and refuses an empty ceiling", async () => {
    const settings = defaultConfig();
    const { server } = renderWithStore(<Settings />, { "settings.get": () => settings });
    const codex = await screen.findByRole("group", { name: "Codex" });
    const input = within(codex).getByLabelText<HTMLInputElement>("Ceiling (%)");
    fireEvent.change(input, { target: { value: "62.5" } });
    expect(input).toHaveValue(62.5);
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a ceiling for Codex");
    fireEvent.change(input, { target: { value: "62.5" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.callsTo("settings.patch")).toHaveLength(1));
    expect(server.callsTo("settings.patch")[0]!.body).toEqual({
      ceilings: { codex: { kind: "utilization", window: "5h", max: 0.625 } },
    });
  });

  it("refuses an empty spend ceiling", async () => {
    const settings = defaultConfig();
    renderWithStore(<Settings />, { "settings.get": () => settings });
    const copilot = await screen.findByRole("group", { name: "Copilot" });
    const input = within(copilot).getByLabelText("Ceiling (US dollars per month)");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a ceiling for Copilot");
  });

  it("edits vendor defaults and the ready-to-push toggle", async () => {
    const settings = defaultConfig();
    settings.vendorDefaults.codex = { model: "gpt-6-codex" };
    const { server } = renderWithStore(<Settings />, { "settings.get": () => settings });
    const claude = await screen.findByRole("group", { name: "Claude defaults" });
    fireEvent.change(within(claude).getByLabelText(/^Model/), {
      target: { value: "claude-opus-5-5" },
    });
    fireEvent.change(within(claude).getByLabelText("Effort"), { target: { value: "high" } });
    fireEvent.change(
      within(screen.getByRole("group", { name: "Codex defaults" })).getByLabelText(/^Model/),
      { target: { value: "" } },
    );
    fireEvent.click(screen.getByLabelText(/ready to push/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.callsTo("settings.patch")).toHaveLength(1));
    expect(server.callsTo("settings.patch")[0]!.body).toEqual({
      vendorDefaults: {
        claude: { model: "claude-opus-5-5", effort: "high" },
        codex: { model: null },
      },
      notifications: { readyToPush: false },
    });
    expect(await screen.findByText("✓ Saved.")).toBeInTheDocument();
    expect(server.state.settings.vendorDefaults.codex.model).toBeUndefined();
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

  it("keeps unsaved edits when settings.changed arrives", async () => {
    const settings = defaultConfig();
    const { store, server } = renderWithStore(<Settings />, { "settings.get": () => settings });
    const codex = await screen.findByRole("group", { name: "Codex" });
    fireEvent.change(within(codex).getByLabelText("Ceiling (%)"), { target: { value: "50" } });
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
    // The edit survives, and the other client's change shows.
    expect(
      within(screen.getByRole("group", { name: "Codex" })).getByLabelText("Ceiling (%)"),
    ).toHaveValue(50);
    expect(
      within(screen.getByRole("group", { name: "Copilot" })).getByLabelText(
        "Ceiling (US dollars per month)",
      ),
    ).toHaveValue(90);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.callsTo("settings.patch")).toHaveLength(1));
    expect(server.callsTo("settings.patch")[0]!.body).toEqual({
      ceilings: { codex: { kind: "utilization", window: "5h", max: 0.5 } },
    });
  });
});
