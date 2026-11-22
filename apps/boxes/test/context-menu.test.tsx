// The box context menu acts on the box that was right-clicked (issues #45
// and #46): a Codex box right-clicked while a Claude box is selected must
// attach to the Codex box's session, the first time as well as the second.
import { FakeServer, makeBoxView } from "@aio/ui/testing";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { renderWithServer } from "./helpers";

function boxes() {
  return [
    makeBoxView({
      box: {
        id: "aio-agent-claude-box",
        targetDir: "/w/site",
        conversationName: "Claude work",
        platform: "claude",
      },
      status: "running",
    }),
    makeBoxView({
      box: {
        id: "aio-agent-codex-box",
        targetDir: "/w/site",
        conversationName: "Codex work",
        platform: "codex",
      },
      status: "running",
    }),
  ];
}

const rowOf = (name: string) => screen.getByRole("cell", { name }).closest("tr") as HTMLElement;

async function renderWithClaudeSelected(server: FakeServer) {
  renderWithServer(<App />, server);
  await screen.findByRole("cell", { name: "Codex work" });
  fireEvent.mouseDown(rowOf("Claude work"), { button: 0 });
  await waitFor(() => expect(rowOf("Claude work")).toHaveAttribute("aria-selected", "true"));
}

afterEach(() => {
  delete window.aio;
});

describe("box context menu", () => {
  it("starts the right-clicked stopped box while a running box is selected", async () => {
    const user = userEvent.setup();
    const [claude, codex] = boxes();
    if (!claude || !codex) throw new Error("Expected two boxes.");
    const server = new FakeServer({ boxes: [claude, { ...codex, status: "stopped" }] });
    await renderWithClaudeSelected(server);

    fireEvent.contextMenu(rowOf("Codex work"));
    await user.click(await screen.findByText("Start", { selector: "span" }));

    await waitFor(() =>
      expect(server.callsTo("boxes.start").map((c) => c.params.boxId)).toEqual([codex.box.id]),
    );
  });

  it("attaches an external terminal to the right-clicked Codex box, not the selected Claude box (#45)", async () => {
    const user = userEvent.setup();
    const openExternalTerminal = vi.fn(async () => ({ ok: true }));
    window.aio = {
      takeToken: () => null,
      serverUrl: "http://127.0.0.1:21400",
      openExternalTerminal,
      launchReview: async () => ({ ok: true }),
      pickDirectory: async () => null,
      readClipboardText: async () => "",
      openPath: async () => ({ ok: true }),
      openExternal: async () => ({ ok: true }),
      onSelectBox: () => () => undefined,
      quit: () => undefined,
    } as never;
    await renderWithClaudeSelected(new FakeServer({ boxes: boxes() }));

    fireEvent.contextMenu(rowOf("Codex work"));
    await user.click(await screen.findByRole("menuitem", { name: /^Attach to Codex Session/ }));

    await waitFor(() => expect(openExternalTerminal).toHaveBeenCalledTimes(1));
    expect(openExternalTerminal.mock.calls[0]).toEqual([
      { boxId: "aio-agent-codex-box", kind: "session" },
    ]);
  });

  it("opens the Codex box's session on the first try, as on the second (#46)", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: boxes() });
    await renderWithClaudeSelected(server);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.contextMenu(rowOf("Codex work"));
      await user.click(await screen.findByRole("menuitem", { name: /^Attach to Codex Session/ }));
      await waitFor(() => expect(server.callsTo("boxes.attachCommand")).toHaveLength(attempt + 1));
      await user.click(await screen.findByRole("button", { name: "OK" }));
    }

    expect(server.callsTo("boxes.attachCommand").map((c) => c.params.boxId)).toEqual([
      "aio-agent-codex-box",
      "aio-agent-codex-box",
    ]);
  });
});
