import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  applyGesture,
  Button,
  Collapsible,
  DataTable,
  Dialog,
  MenuList,
  MessageBoxProvider,
  resizePanes,
  sortRows,
  ToastProvider,
  useInFlight,
  useMessageBox,
  useToast,
  type Column,
} from "../src/index";

interface Row {
  id: string;
  n: number;
}

/**
 * Moves focus to the page body, as a browser does when the focused control
 * becomes disabled. jsdom neither does that nor blurs a disabled control.
 */
function blurToBody() {
  const tmp = document.createElement("button");
  document.body.append(tmp);
  tmp.focus();
  tmp.remove();
}
const columns: Column<Row>[] = [
  { id: "id", header: "Id", render: (r) => r.id, sortValue: (r) => r.id },
  { id: "n", header: "N", render: (r) => String(r.n), sortValue: (r) => r.n },
];

describe("selection", () => {
  const order = ["a", "b", "c", "d"];
  const empty = { selected: new Set<string>(), anchor: null };
  it("clicks, ctrl-clicks, and shift-clicks", () => {
    let s = applyGesture(empty, { kind: "click", key: "b", ctrl: false, shift: false }, order);
    s = applyGesture(s, { kind: "click", key: "d", ctrl: false, shift: true }, order);
    expect([...s.selected]).toEqual(["b", "c", "d"]);
    s = applyGesture(s, { kind: "click", key: "c", ctrl: true, shift: false }, order);
    expect([...s.selected].sort()).toEqual(["b", "d"]);
  });
  it("moves with the arrow keys", () => {
    let s = applyGesture(empty, { kind: "move", delta: 1, shift: false }, order);
    expect([...s.selected]).toEqual(["a"]);
    s = applyGesture(s, { kind: "move", delta: 1, shift: true }, order);
    s = applyGesture(s, { kind: "move", delta: 1, shift: true }, order);
    expect([...s.selected]).toEqual(["a", "b", "c"]);
    expect([...applyGesture(s, { kind: "all" }, order).selected]).toEqual(order);
  });
});

describe("sortRows and resizePanes", () => {
  it("sorts stably in both directions", () => {
    const rows = [
      { id: "b", n: 2 },
      { id: "a", n: 2 },
      { id: "c", n: 1 },
    ];
    expect(sortRows(rows, columns, { column: "n", direction: "asc" }).map((r) => r.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(sortRows(rows, columns, { column: "id", direction: "desc" }).map((r) => r.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
  it("keeps panes above the minimum", () => {
    expect(resizePanes([0.5, 0.5], 0, 0.2)).toEqual([0.7, 0.3]);
    expect(resizePanes([0.5, 0.5], 0, 0.9, 0.1)).toEqual([0.9, 0.09999999999999998]);
  });
});

describe("DataTable", () => {
  function Harness({ onActivate }: { onActivate?: (r: Row) => void }) {
    const [sel, setSel] = useState<Set<string>>(new Set());
    return (
      <DataTable
        rows={[
          { id: "a", n: 1 },
          { id: "b", n: 2 },
          { id: "c", n: 3 },
        ]}
        rowKey={(r) => r.id}
        columns={columns}
        selected={sel}
        onSelectionChange={setSel}
        onActivate={onActivate}
        emptyText="none"
        label="rows"
      />
    );
  }
  it("selects rows and activates on double-click", () => {
    const onActivate = vi.fn();
    render(<Harness onActivate={onActivate} />);
    const rows = screen.getAllByRole("row").slice(1);
    fireEvent.mouseDown(rows[0] as HTMLElement, { button: 0 });
    fireEvent.mouseDown(rows[2] as HTMLElement, { button: 0, shiftKey: true });
    expect(rows.filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(3);
    fireEvent.doubleClick(rows[1] as HTMLElement);
    expect(onActivate).toHaveBeenCalledWith({ id: "b", n: 2 });
  });
  it("sorts when a header is clicked", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("N"));
    fireEvent.click(screen.getByText(/^N/));
    const first = screen.getAllByRole("row")[1] as HTMLElement;
    expect(within(first).getByText("c")).toBeInTheDocument();
  });
  it("shows the empty text", () => {
    render(
      <DataTable
        rows={[]}
        rowKey={(r: Row) => r.id}
        columns={columns}
        selected={new Set()}
        onSelectionChange={() => undefined}
        emptyText="No boxes yet."
      />,
    );
    expect(screen.getByText("No boxes yet.")).toBeInTheDocument();
  });
});

describe("Dialog", () => {
  function Harness({ busy = false, onSubmit }: { busy?: boolean; onSubmit?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <textarea aria-label="Terminal" />
        {open && (
          <Dialog
            title="Edit"
            busy={busy}
            onSubmit={onSubmit}
            onClose={() => setOpen(false)}
            buttons={
              <>
                <Button onClick={() => setOpen(false)}>Cancel</Button>
                <Button primary>OK</Button>
              </>
            }
          >
            <input aria-label="Name" />
          </Dialog>
        )}
      </>
    );
  }

  it("keeps Tab inside the dialog and returns focus when it closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "OK" })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "OK" })).toHaveFocus();
    expect(screen.getByLabelText("Terminal")).not.toHaveFocus();
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("submits on Enter in a field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.type(screen.getByLabelText("Name"), "x{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  // Enter can't reach a disabled field, so a submit event stands in for any
  // other way the form might still be submitted.
  it("disables its fields and submits nothing while busy", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness busy onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  describe("from busy to idle", () => {
    function BusyDialog({ busy, onSubmit }: { busy: boolean; onSubmit?: () => void }) {
      return (
        <Dialog title="Edit" busy={busy} onSubmit={onSubmit} buttons={<Button primary>OK</Button>}>
          <input aria-label="Name" />
          <input aria-label="Path" />
        </Dialog>
      );
    }

    it("enables its fields again and submits on Enter", async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      const { rerender } = render(<BusyDialog busy onSubmit={onSubmit} />);
      expect(screen.getByLabelText("Name")).toBeDisabled();
      rerender(<BusyDialog busy={false} onSubmit={onSubmit} />);
      expect(screen.getByLabelText("Name")).toBeEnabled();
      await user.type(screen.getByLabelText("Name"), "{Enter}");
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it("gives focus back to the field that had it", () => {
      const { rerender } = render(<BusyDialog busy={false} />);
      const path = screen.getByLabelText("Path");
      act(() => path.focus());
      rerender(<BusyDialog busy />);
      act(() => blurToBody());
      rerender(<BusyDialog busy={false} />);
      expect(path).toHaveFocus();
    });

    it("gives focus back when Tab moved it to the dialog while busy", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<BusyDialog busy={false} />);
      const path = screen.getByLabelText("Path");
      act(() => path.focus());
      rerender(<BusyDialog busy />);
      act(() => blurToBody());
      // Nothing in the dialog can take focus, so Tab focuses the dialog itself.
      await user.tab();
      expect(screen.getByRole("dialog")).toHaveFocus();
      rerender(<BusyDialog busy={false} />);
      expect(path).toHaveFocus();
    });

    it("leaves focus on a control that took it meanwhile", () => {
      const { rerender } = render(
        <>
          <BusyDialog busy={false} />
          <button type="button">Elsewhere</button>
        </>,
      );
      act(() => screen.getByLabelText("Path").focus());
      rerender(
        <>
          <BusyDialog busy />
          <button type="button">Elsewhere</button>
        </>,
      );
      const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
      act(() => elsewhere.focus());
      rerender(
        <>
          <BusyDialog busy={false} />
          <button type="button">Elsewhere</button>
        </>,
      );
      expect(elsewhere).toHaveFocus();
    });
  });
});

describe("useInFlight", () => {
  it("runs one request at a time", async () => {
    let finish: () => void = () => undefined;
    const fn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let api: ReturnType<typeof useInFlight> | null = null;
    function Probe() {
      api = useInFlight();
      return <span>{api.busy ? "busy" : "idle"}</span>;
    }
    render(<Probe />);
    let first: Promise<unknown> = Promise.resolve();
    act(() => {
      first = api!.run(fn);
      void api!.run(fn);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(screen.getByText("busy")).toBeInTheDocument();
    await act(async () => {
      finish();
      await first;
    });
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("accepts a call again after one finishes or fails", async () => {
    let api: ReturnType<typeof useInFlight> | null = null;
    function Probe() {
      api = useInFlight();
      return <span>{api.busy ? "busy" : "idle"}</span>;
    }
    render(<Probe />);
    let result: unknown;
    await act(async () => {
      result = await api!.run(async () => "first");
    });
    expect(result).toBe("first");
    await act(async () => {
      await expect(api!.run(() => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
    });
    expect(screen.getByText("idle")).toBeInTheDocument();
    await act(async () => {
      result = await api!.run(async () => "third");
    });
    expect(result).toBe("third");
  });
});

describe("MessageBox", () => {
  function Asker({ onAnswer }: { onAnswer: (a: unknown) => void }) {
    const { ask } = useMessageBox();
    return (
      <button
        onClick={() =>
          void ask({
            title: "Restart All",
            text: "Restart 2 running box(es)?",
            detail: "a\nb",
            checkbox: { label: "Also copy", checked: false },
            buttons: [
              {
                id: "rebuild",
                label: "Rebuild Image...",
                onClick: () => onAnswer("rebuild-clicked"),
              },
              { id: "yes", label: "Yes", primary: true },
              { id: "no", label: "No", cancel: true },
            ],
          }).then(onAnswer)
        }
      >
        go
      </button>
    );
  }
  it("resolves with the button and the checkbox, and keeps open for action buttons", async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageBoxProvider>
        <Asker onAnswer={onAnswer} />
      </MessageBoxProvider>,
    );
    await user.click(screen.getByText("go"));
    expect(screen.getByRole("dialog", { name: "Restart All" })).toBeInTheDocument();
    await user.click(screen.getByText("Rebuild Image..."));
    expect(onAnswer).toHaveBeenCalledWith("rebuild-clicked");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Also copy"));
    await user.click(screen.getByText("Yes"));
    expect(onAnswer).toHaveBeenLastCalledWith({ button: "yes", checked: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("answers with the cancel button on Escape", async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageBoxProvider>
        <Asker onAnswer={onAnswer} />
      </MessageBoxProvider>,
    );
    await user.click(screen.getByText("go"));
    await user.keyboard("{Escape}");
    expect(onAnswer).toHaveBeenLastCalledWith({ button: "no", checked: false });
  });
  it("keeps an open box's checkbox when a second request queues behind it", async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    let ask!: ReturnType<typeof useMessageBox>["ask"];
    function Capture() {
      ask = useMessageBox().ask;
      return null;
    }
    render(
      <MessageBoxProvider>
        <Asker onAnswer={onAnswer} />
        <Capture />
      </MessageBoxProvider>,
    );
    await user.click(screen.getByText("go"));
    await user.click(screen.getByLabelText("Also copy"));
    expect(screen.getByLabelText("Also copy")).toBeChecked();
    act(() => {
      void ask({ title: "SYNTHETIC second", text: "Later", buttons: [{ id: "ok", label: "OK" }] });
    });
    expect(screen.getByRole("dialog", { name: "Restart All" })).toBeInTheDocument();
    expect(screen.getByLabelText("Also copy")).toBeChecked();
    await user.click(screen.getByText("Yes"));
    expect(onAnswer).toHaveBeenLastCalledWith({ button: "yes", checked: true });
    expect(screen.getByRole("dialog", { name: "SYNTHETIC second" })).toBeInTheDocument();
  });
});

describe("menus, toasts, and collapsibles", () => {
  it("runs a menu item and closes, and skips disabled items", async () => {
    const run = vi.fn();
    const off = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <MenuList
        x={0}
        y={0}
        onClose={onClose}
        entries={[
          { label: "Start", chord: "Ctrl+Shift+O", run },
          { type: "separator" },
          { label: "Stop", enabled: false, run: off },
          { label: "Main Platform", submenu: [{ label: "Codex", checked: false, run }] },
        ]}
      />,
    );
    expect(screen.getByText("Ctrl+Shift+O")).toBeInTheDocument();
    expect(screen.getByText("Stop").closest("button")).toBeDisabled();
    await user.click(screen.getByText("Start"));
    expect(run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    await user.hover(screen.getByText("Main Platform"));
    expect(screen.getByRole("menuitemcheckbox", { name: /Codex/ })).toBeInTheDocument();
  });
  it("shows a toast", () => {
    vi.useFakeTimers();
    function T() {
      const toast = useToast();
      return <button onClick={() => toast("Saved", { kind: "success" })}>t</button>;
    }
    render(
      <ToastProvider>
        <T />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("t"));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText("Saved")).toBeNull();
    vi.useRealTimers();
  });
  it("opens a collapsible section", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible title="Folders">
        <span>body</span>
      </Collapsible>,
    );
    expect(screen.queryByText("body")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Folders/ }));
    expect(screen.getByText("body")).toBeInTheDocument();
  });
});
