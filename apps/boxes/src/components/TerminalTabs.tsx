// The tab strip of embedded terminals. Every tab stays mounted, so a
// session stays attached while another tab is in front.
import { StatusDot, TerminalView, useApiClient, useContextMenu } from "@aio/ui";
import { tabTitle, type Tab, type TabsState } from "../logic/tabs";

export interface TerminalTabsProps {
  state: TabsState;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onCloseOthers: (key: string) => void;
  onCloseAll: () => void;
  onEnded: (key: string, exitCode: number | null) => void;
  openLink: (url: string) => void;
  /**
   * The machine name of a multi-machine window. Every tab title then starts
   * with `MACHINE / `, so boxes with one name on two PCs stay apart.
   */
  machineLabel?: string;
  /** False while another machine's view is in front; no terminal takes focus then. */
  visible?: boolean;
}

export function TerminalTabs(props: TerminalTabsProps) {
  const client = useApiClient();
  const menu = useContextMenu();
  const { tabs, current } = props.state;
  const titleOf = (t: Tab) =>
    props.machineLabel ? `${props.machineLabel} / ${tabTitle(t)}` : tabTitle(t);
  const visible = props.visible ?? true;
  if (tabs.length === 0) {
    return (
      <div className="bx-terminal-placeholder">
        Double-click a running box, or select one and press Start (Ctrl+Shift+O), to open its
        terminal here.
      </div>
    );
  }
  return (
    <div className="bx-terminals">
      <div className="ab-tabbar" role="tablist" aria-label="Terminals">
        {tabs.map((t, i) => (
          <div
            key={t.key}
            role="tab"
            tabIndex={0}
            aria-selected={t.key === current}
            className={`ab-tab${t.key === current ? " ab-active" : ""}`}
            title={`${props.machineLabel ? `${props.machineLabel}: ` : ""}${t.tooltip}${
              i < 9 ? `  (Alt+${i + 1})` : ""
            }`}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                props.onClose(t.key);
              }
            }}
            onClick={() => props.onSelect(t.key)}
            onContextMenu={(e) => {
              e.preventDefault();
              menu.open(e.clientX, e.clientY, [
                { label: "Close Tab", run: () => props.onClose(t.key) },
                {
                  label: "Close Other Tabs",
                  enabled: tabs.length > 1,
                  run: () => props.onCloseOthers(t.key),
                },
                { label: "Close All Tabs", run: props.onCloseAll },
              ]);
            }}
          >
            <StatusDot decorative state={t.ended ? "stopped" : "running"} />
            <span>{titleOf(t)}</span>
            <button
              type="button"
              className="ab-tab-close"
              aria-label={`Close ${titleOf(t)}`}
              onClick={(e) => {
                e.stopPropagation();
                props.onClose(t.key);
              }}
            >
              {"×"}
            </button>
          </div>
        ))}
      </div>
      {tabs.map((t: Tab) => (
        <div key={t.key} className="bx-terminal-pane" role="tabpanel" hidden={t.key !== current}>
          <TerminalView
            client={client}
            target={
              t.kind === "side" && t.platform
                ? { kind: "side", boxId: t.boxId, platform: t.platform }
                : t.kind === "shell"
                  ? { kind: "shell", boxId: t.boxId }
                  : { kind: "session", boxId: t.boxId }
            }
            active={visible && t.key === current}
            onExit={(code) => props.onEnded(t.key, code)}
            openLink={props.openLink}
          />
        </div>
      ))}
      {menu.element}
    </div>
  );
}
