// Test setup: jest-dom matchers, cleanup after each test, and a stand-in
// for xterm.js, which needs a canvas that jsdom doesn't have.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    // No storage in this environment.
  }
});

vi.mock("@xterm/xterm", () => {
  const disposable = () => ({ dispose: () => undefined });
  class Terminal {
    cols = 80;
    rows = 24;
    written: (string | Uint8Array)[] = [];
    loadAddon() {}
    open(el: HTMLElement) {
      el.setAttribute("data-fake-terminal", "true");
    }
    attachCustomKeyEventHandler() {}
    onData = disposable;
    onBinary = disposable;
    onResize = disposable;
    onBell = disposable;
    write(d: string | Uint8Array) {
      this.written.push(d);
    }
    paste() {}
    getSelection() {
      return "";
    }
    selectAll() {}
    clearSelection() {}
    focus() {}
    dispose() {}
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
