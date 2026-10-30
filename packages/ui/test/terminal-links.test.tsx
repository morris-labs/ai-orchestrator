import { render } from "@testing-library/react";
import type { ILinkHandler, ITerminalOptions } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/core";
import { TerminalView } from "../src/terminal/TerminalView";
import { isOpenableLink, openTerminalLink } from "../src/terminal/links";
import { FakeServer } from "../src/testing";

// A stand-in for xterm.js that records the options it was built with; jsdom
// has no canvas for the real one.
const built: ITerminalOptions[] = [];
vi.mock("@xterm/xterm", () => {
  const disposable = () => ({ dispose: () => {} });
  class Terminal {
    cols = 80;
    rows = 24;
    constructor(options: ITerminalOptions) {
      built.push(options);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData = disposable;
    onBinary = disposable;
    onResize = disposable;
    onBell = disposable;
    write() {}
    focus() {}
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
  built.length = 0;
  vi.restoreAllMocks();
});

describe("terminal links", () => {
  it("opens only http and https links", () => {
    expect(isOpenableLink("https://example.com/a")).toBe(true);
    expect(isOpenableLink("http://192.0.2.1:8080/")).toBe(true);
    expect(isOpenableLink("file:///etc/passwd")).toBe(false);
    expect(isOpenableLink("javascript:alert(1)")).toBe(false);
    expect(isOpenableLink("not a url")).toBe(false);
    const open = vi.fn();
    openTerminalLink("file:///etc/passwd", open);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens an OSC 8 link's URL directly, never about:blank first", () => {
    const server = new FakeServer();
    const client = new ApiClient({ fetch: server.fetch, token: "t", WebSocket: server.WebSocket });
    const openLink = vi.fn();
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const { rerender } = render(
      <TerminalView
        client={client}
        target={{ kind: "job", jobId: "SYNTHETIC_job" }}
        openLink={openLink}
      />,
    );
    const handler = built[0]?.linkHandler as ILinkHandler | undefined;
    expect(handler).toBeDefined();
    const click = new MouseEvent("click");
    const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } };
    handler!.activate(click, "https://example.com/docs", range);
    expect(openLink).toHaveBeenCalledWith("https://example.com/docs");

    // Without an `openLink` prop, the URL goes straight to `window.open`.
    rerender(<TerminalView client={client} target={{ kind: "job", jobId: "SYNTHETIC_job" }} />);
    handler!.activate(click, "https://example.com/other", range);
    expect(windowOpen).toHaveBeenCalledWith("https://example.com/other", "_blank", "noopener");
    expect(windowOpen).not.toHaveBeenCalledWith();
  });
});
