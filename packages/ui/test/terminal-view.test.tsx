// TerminalView with a stand-in for xterm.js, and the bell.
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/components/Dialog";
import { ApiClient } from "../src/core";
import { TerminalView } from "../src/terminal/TerminalView";
import { FakeServer, type FakeSocket } from "../src/testing";

const focusTerminal = vi.hoisted(() => vi.fn());

// jsdom has no canvas for the real xterm.js.
vi.mock("@xterm/xterm", () => {
  const disposable = () => ({ dispose: () => {} });
  class Terminal {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData = disposable;
    onBinary = disposable;
    onResize = disposable;
    onBell = disposable;
    write() {}
    focus() {
      focusTerminal();
    }
    dispose() {}
    getSelection() {
      return "";
    }
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("TerminalView", () => {
  it("leaves focus with a visible dialog when it becomes active", () => {
    const server = new FakeServer();
    const client = new ApiClient({ fetch: server.fetch, token: "t", WebSocket: server.WebSocket });
    const view = (active: boolean, hidden: boolean) => (
      <div hidden={hidden}>
        <TerminalView
          active={active}
          client={client}
          target={{ kind: "job", jobId: "SYNTHETIC_one" }}
        />
        <Dialog title="Rename">
          <input aria-label="Name" />
        </Dialog>
      </div>
    );
    focusTerminal.mockClear();
    const { rerender } = render(view(false, true));
    rerender(view(true, false));
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("takes focus when it becomes active with no dialog in front", () => {
    const server = new FakeServer();
    const client = new ApiClient({ fetch: server.fetch, token: "t", WebSocket: server.WebSocket });
    const view = (active: boolean) => (
      <>
        <TerminalView
          active={active}
          client={client}
          target={{ kind: "job", jobId: "SYNTHETIC_one" }}
        />
        <div hidden>
          <Dialog title="Hidden">
            <input aria-label="Name" />
          </Dialog>
        </div>
      </>
    );
    focusTerminal.mockClear();
    const { rerender } = render(view(false));
    rerender(view(true));
    expect(focusTerminal).toHaveBeenCalledTimes(1);
  });

  it("drops the ended banner when its target changes to a new session", () => {
    const server = new FakeServer();
    const client = new ApiClient({ fetch: server.fetch, token: "t", WebSocket: server.WebSocket });
    const { rerender } = render(
      <TerminalView client={client} target={{ kind: "job", jobId: "SYNTHETIC_one" }} />,
    );
    const first = server.socketsFor("/jobs/SYNTHETIC_one/stream")[0] as FakeSocket;
    act(() => first.serverClose());
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(<TerminalView client={client} target={{ kind: "job", jobId: "SYNTHETIC_two" }} />);
    expect(server.socketsFor("/jobs/SYNTHETIC_two/stream")).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("beep", () => {
  it("resumes an audio context that the autoplay policy left suspended", async () => {
    const resume = vi.fn(async () => undefined);
    const node = () => ({
      connect: (next: unknown) => next,
      start: () => undefined,
      stop: () => undefined,
      frequency: { value: 0 },
      gain: { value: 0 },
    });
    class FakeAudioContext {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume = resume;
      createOscillator = node;
      createGain = node;
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.resetModules();
    const { beep } = await import("../src/terminal/beep");
    beep();
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
