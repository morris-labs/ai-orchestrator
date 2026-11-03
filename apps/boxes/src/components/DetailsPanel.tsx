// The properties of the selected box: the record merged with its live
// state, a Relink button, the SSH section with Reconnect, dev-server links,
// and CPU and memory bars.
import { boxWorkDir, type BoxView, type GlobalSettings, type Project } from "@aio/contracts";
import { Button, ProgressBar, StatusDot } from "@aio/ui";
import type { ReactNode } from "react";
import { formatBytes } from "../logic/format";
import { formatMount } from "../logic/mounts";
import { platformLabel, statusDot, statusLabel } from "../logic/status";

export interface SshRemoteStatus {
  name: string;
  host: string;
  tunnelUp: boolean;
  tunnelError: string | null;
}

export interface DetailsPanelProps {
  view: BoxView | null;
  project: Project | undefined;
  /** How the box's project container differs from the project's settings; see `ContainerInfo.stale`. */
  containerStale?: string[];
  settings: GlobalSettings | null;
  diskBytes: number | undefined;
  remotes: SshRemoteStatus[];
  onRelink: (view: BoxView) => void;
  onReconnect: (remote: string) => void;
  onOpenLink: (url: string) => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bx-detail">
      <div className="bx-detail-label">{label}</div>
      <div className="bx-detail-value">{children}</div>
    </div>
  );
}

const dash = <span className="bx-dim">-</span>;

export function DetailsPanel(props: DetailsPanelProps) {
  const { view } = props;
  if (!view) {
    return (
      <aside className="bx-details" aria-label="Details">
        <div className="bx-dim">Select one box to see its details.</div>
      </aside>
    );
  }
  const { box, stats } = view;
  const running = view.status === "running";
  const flags = [
    box.skipPermissions ? "bypass permissions available" : "permission prompts",
    box.model ? `model ${box.model}` : "model from settings",
    box.effort ? `effort ${box.effort}` : "effort from settings",
  ];
  const mounts = [...(props.project?.mounts ?? []), ...(props.settings?.globalMounts ?? [])];
  const cpu = stats ? stats.cpuPercent / 100 : 0;
  const mem = stats && stats.memLimitBytes > 0 ? stats.memBytes / stats.memLimitBytes : 0;
  return (
    <aside className="bx-details" aria-label="Details">
      <Field label="Status">
        <span className="bx-status">
          <StatusDot state={statusDot[view.status]} /> {statusLabel[view.status]}
          {view.reviewState.state === "under_review" && (
            <span className="bx-badge">under review</span>
          )}
        </span>
      </Field>
      <Field label="Conversation">{box.conversationName || dash}</Field>
      <Field label="Box">{box.id}</Field>
      <Field label="Container">
        {view.container} <span className="bx-dim">(tmux session {view.tmuxSession})</span>
        {props.containerStale && props.containerStale.length > 0 && (
          <div className="ab-error-text">
            Runs with old settings: {props.containerStale.join(", ")}. Restart the container to
            apply the project settings.
          </div>
        )}
      </Field>
      <Field label="Directory">
        <div className="bx-row">
          <span className="bx-wrap">
            {box.targetDir}
            {!view.targetDirExists && (
              <span className="bx-missing" title="The directory doesn't exist on the host.">
                [missing]
              </span>
            )}
          </span>
          <Button
            disabled={running}
            title={running ? "Stop the box before relinking its directory." : undefined}
            onClick={() => props.onRelink(view)}
          >
            Relink...
          </Button>
        </div>
      </Field>
      {box.worktree && (
        <Field label="Worktree">
          <span className="bx-wrap">
            {box.worktree}
            {box.branch ? ` (branch ${box.branch})` : ""}
          </span>
        </Field>
      )}
      {box.workspace && <Field label="Workspace">{box.workspace}</Field>}
      <Field label="Working directory">{boxWorkDir(box)}</Field>
      <Field label="Session">
        {box.sessionUuid ?? <span className="bx-dim">new conversation on next start</span>}
      </Field>
      <Field label="Platform">
        {platformLabel[box.platform]}
        {view.sideSessions.length > 0 && (
          <span className="bx-dim">
            {" "}
            (remote sessions: {view.sideSessions.map((p) => platformLabel[p]).join(", ")})
          </span>
        )}
      </Field>
      <Field label="Flags">{flags.join(", ")}</Field>
      <Field label="Dev servers">
        {view.proxyUrls.length === 0 ? (
          <span className="bx-dim">{running ? "nothing listening yet" : "-"}</span>
        ) : (
          <ul className="bx-list">
            {view.proxyUrls.map((p) => (
              <li key={p.port}>
                <a
                  href={p.url}
                  onClick={(e) => {
                    e.preventDefault();
                    props.onOpenLink(p.url);
                  }}
                  onAuxClick={(e) => {
                    // A middle click opens through the same check as a click.
                    if (e.button !== 1) return;
                    e.preventDefault();
                    props.onOpenLink(p.url);
                  }}
                >
                  {p.url}
                </a>
                <span className="bx-dim">
                  {" "}
                  port {p.port}
                  {(() => {
                    const proc = view.listeners.find((l) => l.port === p.port)?.process;
                    return proc ? `, ${proc}` : "";
                  })()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Field>
      <Field label="TCP maps">
        {props.project && props.project.tcpMaps.length > 0
          ? props.project.tcpMaps.map((m) => `${m.host}:${m.container}`).join(", ")
          : dash}
      </Field>
      <Field label="Mounts">
        {mounts.length > 0 ? (
          <ul className="bx-list">
            {mounts.map((m) => (
              <li key={`${m.host}:${m.container}`}>{formatMount(m)}</li>
            ))}
          </ul>
        ) : (
          dash
        )}
      </Field>
      <Field label="SSH remotes">
        {props.remotes.length === 0
          ? dash
          : props.remotes.map((r) => (
              <div key={r.name} className="bx-row">
                <StatusDot
                  state={r.tunnelUp ? "running" : "stopped"}
                  title={r.tunnelUp ? "tunnel up" : "tunnel down"}
                />
                <span>
                  {r.name} <span className="bx-dim">{r.host}</span>
                  {r.tunnelError && <div className="ab-error-text">{r.tunnelError}</div>}
                </span>
                <Button onClick={() => props.onReconnect(r.name)}>Reconnect</Button>
              </div>
            ))}
      </Field>
      <Field label="CPU">
        {stats ? <ProgressBar fraction={cpu} label={`${stats.cpuPercent.toFixed(1)}%`} /> : dash}
      </Field>
      <Field label="Memory">
        {stats ? (
          <ProgressBar
            fraction={mem}
            label={`${formatBytes(stats.memBytes)} / ${formatBytes(stats.memLimitBytes)}`}
          />
        ) : (
          dash
        )}
      </Field>
      <Field label="Disk">
        {props.diskBytes !== undefined ? formatBytes(props.diskBytes) : dash}
      </Field>
      <div className="bx-dim bx-small">Stats are for the whole project container.</div>
    </aside>
  );
}
