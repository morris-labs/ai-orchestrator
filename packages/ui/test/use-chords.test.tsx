// useChords against a focused terminal: application chords go to the app,
// and every other key, plain Ctrl ones included, reaches the terminal.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChords, type ChordBinding } from "../src/index";

function App({
  bindings,
  onTerminalKey,
}: {
  bindings: ChordBinding[];
  onTerminalKey: (key: string) => void;
}) {
  useChords(bindings);
  // xterm.js reads keys from a focused textarea, so a textarea stands in for it.
  return <textarea aria-label="terminal" onKeyDown={(e) => onTerminalKey(e.key)} />;
}

function setup(bindings: ChordBinding[]) {
  const terminalKeys: string[] = [];
  render(<App bindings={bindings} onTerminalKey={(k) => terminalKeys.push(k)} />);
  const terminal = screen.getByLabelText("terminal");
  terminal.focus();
  return { terminal, terminalKeys };
}

describe("useChords", () => {
  it("runs a bound Ctrl+Shift chord and keeps it from the focused terminal", () => {
    const run = vi.fn();
    const { terminal, terminalKeys } = setup([{ chord: "Ctrl+Shift+N", run }]);
    const delivered = fireEvent.keyDown(terminal, {
      key: "N",
      code: "KeyN",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(terminalKeys).toEqual([]);
    expect(delivered).toBe(false);
  });

  it("leaves a plain Ctrl key to the terminal", () => {
    const run = vi.fn();
    const { terminal, terminalKeys } = setup([{ chord: "Ctrl+Shift+N", run }]);
    expect(fireEvent.keyDown(terminal, { key: "n", code: "KeyN", ctrlKey: true })).toBe(true);
    fireEvent.keyDown(terminal, { key: "c", code: "KeyC", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(terminalKeys).toEqual(["n", "c"]);
  });

  it("swallows a disabled binding without running it", () => {
    const run = vi.fn();
    const { terminal, terminalKeys } = setup([{ chord: "Ctrl+Shift+W", run, enabled: false }]);
    fireEvent.keyDown(terminal, { key: "W", code: "KeyW", ctrlKey: true, shiftKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(terminalKeys).toEqual([]);
  });

  it("leaves an application chord with no binding to the terminal", () => {
    const { terminal, terminalKeys } = setup([]);
    fireEvent.keyDown(terminal, { key: "F5", code: "F5" });
    fireEvent.keyDown(terminal, { key: "Q", code: "KeyQ", ctrlKey: true, shiftKey: true });
    expect(terminalKeys).toEqual(["F5", "Q"]);
  });

  it("runs Alt+digit and bare F5 bindings", () => {
    const tab = vi.fn();
    const refresh = vi.fn();
    const { terminal, terminalKeys } = setup([
      { chord: "Alt+2", run: tab },
      { chord: "F5", run: refresh },
    ]);
    fireEvent.keyDown(terminal, { key: "2", code: "Digit2", altKey: true });
    fireEvent.keyDown(terminal, { key: "F5", code: "F5" });
    fireEvent.keyDown(terminal, { key: "F5", code: "F5", ctrlKey: true });
    expect(tab).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(terminalKeys).toEqual(["F5"]);
  });
});
