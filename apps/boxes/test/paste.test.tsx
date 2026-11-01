import { FakeServer } from "@aio/ui/testing";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AioBridge } from "../src/bridge";
import { BoxDialog, type BoxDialogResult } from "../src/dialogs/BoxDialog";
import { InputDialog } from "../src/dialogs/InputDialog";
import { cleanPastedPath } from "../src/logic/mounts";
import { renderWithServer } from "./helpers";

/** Installs a bridge whose clipboard holds `text`; returns the mock reader. */
function mockClipboard(text: string) {
  const readClipboardText = vi.fn(async () => text);
  window.aio = { readClipboardText } as unknown as AioBridge;
  return readClipboardText;
}

afterEach(() => {
  delete window.aio;
});

describe("cleanPastedPath", () => {
  it.each([
    ["  /data  ", "/data"],
    ['"/srv/my data"', "/srv/my data"],
    ["'/srv/x'\n", "/srv/x"],
    ["\n\n /first \r\n/second", "/first"],
    ['"/unbalanced', '"/unbalanced'],
    ["~/data", "~/data"],
    ["   \n  ", ""],
  ])("cleans %j to %j", (input, out) => {
    expect(cleanPastedPath(input)).toBe(out);
  });
});

function newDialog(server: FakeServer) {
  const onAccept = vi.fn(async (_r: BoxDialogResult) => null as string | null);
  renderWithServer(
    <BoxDialog
      mode="new"
      projects={server.state.projects}
      settings={server.state.settings}
      initialDir="/w/site"
      onAccept={onAccept}
      onCancel={() => undefined}
      onManageRemotes={() => undefined}
    />,
    server,
  );
  return { onAccept };
}

describe("BoxDialog, Paste buttons", () => {
  it("pastes the cleaned first line into the mount fields through the bridge", async () => {
    const user = userEvent.setup();
    const read = mockClipboard('  "/srv/shared data"\n/ignored\n');
    const { onAccept } = newDialog(new FakeServer());
    await user.click(screen.getByRole("button", { name: /Add folders to sandbox/ }));
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    await user.click(
      screen.getByRole("button", { name: "Paste host folder 1 from the clipboard" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Host folder 1")).toHaveValue("/srv/shared data"),
    );
    read.mockResolvedValueOnce("/mnt/box\n");
    await user.click(screen.getByRole("button", { name: "Paste box folder 1 from the clipboard" }));
    await waitFor(() => expect(screen.getByLabelText("Box folder 1")).toHaveValue("/mnt/box"));
    expect(read).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalled());
    expect((onAccept.mock.calls[0]?.[0] as BoxDialogResult).project?.mounts).toEqual([
      { host: "/srv/shared data", container: "/mnt/box" },
    ]);
  });

  it("runs the same validation as typing on a pasted path", async () => {
    const user = userEvent.setup();
    mockClipboard("~/data");
    const { onAccept } = newDialog(new FakeServer());
    await user.click(screen.getByRole("button", { name: /Add folders to sandbox/ }));
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    await user.click(
      screen.getByRole("button", { name: "Paste host folder 1 from the clipboard" }),
    );
    await waitFor(() => expect(screen.getByLabelText("Host folder 1")).toHaveValue("~/data"));
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the host path must be absolute");
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("pastes the target directory and leaves a field alone for an empty clipboard", async () => {
    const user = userEvent.setup();
    const read = mockClipboard("   \n");
    newDialog(new FakeServer());
    const dir = screen.getByLabelText("Target directory");
    const paste = screen.getByRole("button", {
      name: "Paste target directory from the clipboard",
    });
    await user.click(paste);
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(dir).toHaveValue("/w/site");
    read.mockResolvedValueOnce("'/w/other/'");
    await user.click(paste);
    await waitFor(() => expect(dir).toHaveValue("/w/other/"));
  });
});

describe("InputDialog, Paste button", () => {
  it("shows Paste with Browse and fills the field", async () => {
    const user = userEvent.setup();
    mockClipboard(" /w/moved \n");
    renderWithServer(
      <InputDialog
        title="Move"
        label="Working directory"
        initial="/w/site"
        browse
        onAccept={async () => null}
        onCancel={() => undefined}
      />,
      new FakeServer(),
    );
    await user.click(
      screen.getByRole("button", { name: "Paste working directory from the clipboard" }),
    );
    await waitFor(() => expect(screen.getByLabelText("Working directory")).toHaveValue("/w/moved"));
  });
});
