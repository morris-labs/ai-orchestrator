// A terminal pane: xterm.js bound to a terminal or job WebSocket. It has
// scrollback, mouse selection, Ctrl+Shift+C and Ctrl+Shift+V, a context menu,
// clickable links, and the bell. When the attached process ends, the pane
// keeps its last screen, dims it, and shows a banner with the exit code.
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { ApiClient } from "../api/client";
import { dialogBlocksFocus } from "../components/Dialog";
import { useContextMenu } from "../components/Menu";
import { terminalTheme } from "../theme/tokens";
import { beep } from "./beep";
import { openTerminalSocket, TerminalConnection, type TerminalTarget } from "./connection";
import { endedBanner, handleTerminalKey } from "./keys";
import { oscLinkHandler, openTerminalLink } from "./links";

/** Clipboard access; Electron and the browser both provide `navigator.clipboard`. */
export interface ClipboardLike {
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<void>;
}

export interface TerminalHandle {
  focus: () => void;
  copy: () => void;
  paste: () => void;
  clear: () => void;
}

export interface TerminalViewProps {
  client: ApiClient;
  target: TerminalTarget;
  /** Focuses the terminal when it becomes true, unless a dialog in front holds focus. */
  active?: boolean;
  onExit?: (exitCode: number | null) => void;
  onReady?: (terminalId: string) => void;
  /** The second line of the ended banner. */
  endedSubject?: string;
  /** False hides the banner, for a job view that shows its own status. */
  showBanner?: boolean;
  clipboard?: ClipboardLike;
  /** Opens a link the user clicked. */
  openLink?: (url: string) => void;
  scrollback?: number;
  handle?: Ref<TerminalHandle>;
}

export function TerminalView(props: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const connRef = useRef<TerminalConnection | null>(null);
  const [ended, setEnded] = useState<{ code: number | null } | null>(null);
  const menu = useContextMenu();
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  const clipboard = (): ClipboardLike | undefined =>
    propsRef.current.clipboard ??
    (typeof navigator !== "undefined" ? navigator.clipboard : undefined);

  const copy = () => {
    const text = termRef.current?.getSelection() ?? "";
    if (text !== "") void clipboard()?.writeText(text);
  };
  const paste = () => {
    const term = termRef.current;
    if (!term || connRef.current?.isEnded) return;
    void clipboard()
      ?.readText()
      .then((text) => text && term.paste(text));
  };

  useImperativeHandle(props.handle, () => ({
    focus: () => termRef.current?.focus(),
    copy,
    paste,
    clear: () => termRef.current?.clearSelection(),
  }));

  const { client } = props;
  const targetKey = JSON.stringify(props.target);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A new target is a new session, so the previous one's banner goes.
    setEnded(null);
    const term = new Terminal({
      scrollback: propsRef.current.scrollback ?? 10_000,
      theme: terminalTheme,
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--ab-mono") || "monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      linkHandler: oscLinkHandler(() => propsRef.current.openLink),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_e, url) => openTerminalLink(url, propsRef.current.openLink)),
    );
    term.open(host);
    try {
      fit.fit();
    } catch {
      // A hidden pane has no size yet; the observer fits it later.
    }

    term.attachCustomKeyEventHandler((e) => handleTerminalKey(e, { copy, paste }));

    const target: TerminalTarget = JSON.parse(targetKey) as TerminalTarget;
    const socket = openTerminalSocket(client, target, { cols: term.cols, rows: term.rows });
    const conn = new TerminalConnection(socket, {
      onData: (data) => term.write(data),
      onReady: (id) => propsRef.current.onReady?.(id),
      onExit: (code) => {
        setEnded({ code });
        propsRef.current.onExit?.(code);
      },
      onError: (error) => term.write(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`),
    });
    connRef.current = conn;
    socket.addEventListener?.("open", () => conn.resize(term.cols, term.rows));

    const input = term.onData((data) => conn.write(data));
    const bin = term.onBinary((data) => conn.writeBinary(data));
    const resize = term.onResize(({ cols, rows }) => conn.resize(cols, rows));
    const bell = term.onBell(() => beep());

    let frame = 0;
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              if (host.clientWidth > 0 && host.clientHeight > 0) {
                try {
                  fit.fit();
                } catch {
                  // Ignore a fit during teardown.
                }
              }
            });
          })
        : null;
    observer?.observe(host);

    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      input.dispose();
      bin.dispose();
      resize.dispose();
      bell.dispose();
      conn.close();
      term.dispose();
      termRef.current = null;
      connRef.current = null;
    };
    // `targetKey` stands for `props.target`; a new target is a new session.
  }, [client, targetKey]);

  useEffect(() => {
    if (props.active && !dialogBlocksFocus(hostRef.current)) termRef.current?.focus();
  }, [props.active]);

  return (
    <div
      className={`ab-terminal${ended ? " ab-disconnected" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        const hasSel = (termRef.current?.getSelection() ?? "") !== "";
        menu.open(e.clientX, e.clientY, [
          { label: "Copy", chord: "Ctrl+Shift+C", enabled: hasSel, run: copy },
          { label: "Paste", chord: "Ctrl+Shift+V", enabled: !ended, run: paste },
          { type: "separator" },
          { label: "Select All", run: () => termRef.current?.selectAll() },
          {
            label: "Clear Selection",
            enabled: hasSel,
            run: () => termRef.current?.clearSelection(),
          },
        ]);
      }}
    >
      <div ref={hostRef} className="ab-terminal-host" />
      {ended && props.showBanner !== false && (
        <div className="ab-terminal-banner" role="status">
          {endedBanner(ended.code, props.endedSubject)}
        </div>
      )}
      {menu.element}
    </div>
  );
}
