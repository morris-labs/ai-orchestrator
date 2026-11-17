import { Button, Dialog } from "./Dialog";
import { TerminalView } from "../terminal/TerminalView";
import type { ImageStatus, Machine, Updates, UpgradePreview } from "@aio/contracts";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../api/errors";
import { useApiClient } from "../api/react";
import { useResync, useStreamStatus } from "../events/react";

// Compare numeric release parts, then SemVer prerelease identifiers.
function newer(candidate: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split("+")[0]!.split("-", 2);
  const [a, ap] = parts(candidate),
    [b, bp] = parts(current);
  const av = a!.split(".").map(Number),
    bv = b!.split(".").map(Number);
  if ([...av, ...bv].some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (av[i] ?? 0) > (bv[i] ?? 0);
  }
  if (ap === bp) return false;
  if (!ap) return true;
  if (!bp) return false;
  const ai = ap.split("."),
    bi = bp.split(".");
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i],
      y = bi[i];
    if (x === y) continue;
    if (x === undefined) return false;
    if (y === undefined) return true;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    return xn && yn ? Number(x) > Number(y) : xn !== yn ? !xn : x > y;
  }
  return false;
}

/** Status shared by both desktop apps; every connection refreshes server-owned notices. */
export function UpgradeStatus({
  runningVersion,
  onStatus,
  showCliNotice = true,
  onRelaunch,
}: {
  runningVersion: string;
  onRelaunch?: () => void;
  onStatus?: (updates: Updates, image: ImageStatus) => void;
  showCliNotice?: boolean;
}) {
  const client = useApiClient();
  const connection = useStreamStatus();
  const [updates, setUpdates] = useState<Updates | null>(null);
  const [image, setImage] = useState<ImageStatus | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [preview, setPreview] = useState<UpgradePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const reload = useCallback(() => {
    void Promise.all([client.call("updates.check", {}), client.call("image.status", {})])
      .then(([u, i]) => {
        setUpdates(u);
        setImage(i);
        onStatus?.(u, i);
      })
      .catch(() => undefined);
    void client
      .call("machines.list", {})
      .then((r) => setMachines(r.machines))
      .catch(() => undefined);
  }, [client, onStatus]);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (connection === "open") reload();
  }, [reload, connection]);
  useResync(reload);
  // While an upgrade runs, poll only the image status; update checks reach
  // GitHub and npm and stay on the reconnect and resync path.
  const pollImage = useCallback(() => {
    void client
      .call("image.status", {})
      .then((i) => {
        setImage(i);
        if (updates) onStatus?.(updates, i);
        if (!i.upgrading) reload();
      })
      .catch(() => undefined);
  }, [client, onStatus, reload, updates]);
  useEffect(() => {
    if (!image?.upgrading && !busy) return;
    const timer = setInterval(pollImage, 2000);
    return () => clearInterval(timer);
  }, [image?.upgrading, busy, pollImage]);
  const hubVersion = machines.find((m) => m.isLocal)?.serverVersion;

  const previewUpdate = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await client.call("upgrade.preview", {}));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const startUpdate = async () => {
    setPreview(null);
    setBusy(true);
    setError(null);
    try {
      const report = await client.call("upgrade.start", {});
      const failed = [...report.boxes, ...report.runs]
        .filter((r) => !r.restored)
        .map((r) => `${r.name}: ${r.reason ?? "could not restore"}`);
      setResult(
        report.error ??
          (failed.length
            ? failed.join("; ")
            : report.fallback
              ? "CLI update complete using pinned CLI versions."
              : "CLI update complete; open work restored."),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      reload();
    }
  };
  return (
    <div aria-label="Upgrade status" data-running-version={runningVersion}>
      {hubVersion &&
        machines
          .filter((m) => !m.isLocal && m.serverVersion && newer(hubVersion, m.serverVersion))
          .map((m) => (
            <div key={m.id} role="status" className="ab-update-bar">
              {m.name} runs {m.serverVersion}; the hub runs {hubVersion}. Upgrade {m.name} on that
              machine.
            </div>
          ))}
      <Button disabled={busy || image?.upgrading} onClick={() => void previewUpdate()}>
        CLI update
      </Button>
      {busy && <div role="status">Updating CLIs…</div>}
      {error && <div role="alert">{error}</div>}
      {result && <div role="status">{result}</div>}
      {preview && (
        <Dialog
          title="Update agent CLIs?"
          onClose={() => setPreview(null)}
          buttons={
            <>
              <Button onClick={() => setPreview(null)}>Cancel</Button>
              <Button primary onClick={() => void startUpdate()}>
                Update CLIs
              </Button>
            </>
          }
        >
          <p>
            The update stops these boxes and review runs, rebuilds the image, then restores the
            work.
          </p>
          <h3>Boxes</h3>
          {preview.boxes.length ? (
            <ul>
              {preview.boxes.map((b) => (
                <li key={b.id}>{b.name}</li>
              ))}
            </ul>
          ) : (
            <p>No open boxes.</p>
          )}
          <h3>Review runs</h3>
          {preview.runs.length ? (
            <ul>
              {preview.runs.map((r) => (
                <li key={r.run_id}>{r.name}</li>
              ))}
            </ul>
          ) : (
            <p>No active review runs.</p>
          )}
        </Dialog>
      )}
      {updates?.installedVersion && newer(updates.installedVersion, runningVersion) && (
        <div role="status" className="ab-update-bar">
          <span>
            AI Orchestrator {updates.installedVersion} is installed; relaunch to use it (running{" "}
            {runningVersion}).
          </span>
          <Button onClick={onRelaunch ?? (() => window.location.reload())}>Relaunch</Button>
        </div>
      )}
      {image?.upgrading && (
        <div role="status" className="ab-update-bar">
          <span>Upgrading: building the image</span>
          {image.buildLogJobId && (
            <a
              href={client.url("jobs.get", { params: { jobId: image.buildLogJobId } })}
              onClick={(e) => {
                e.preventDefault();
                setLogOpen(true);
              }}
            >
              Build log
            </a>
          )}
        </div>
      )}
      {logOpen && image?.buildLogJobId && (
        <Dialog
          title="Image build log"
          onClose={() => setLogOpen(false)}
          buttons={<Button onClick={() => setLogOpen(false)}>Close</Button>}
        >
          <div style={{ height: 400 }}>
            <TerminalView
              client={client}
              target={{ kind: "job", jobId: image.buildLogJobId }}
              showBanner={false}
            />
          </div>
        </Dialog>
      )}
      {showCliNotice && updates?.claudeCode.stale && (
        <div role="status" className="ab-update-bar">
          Claude Code {updates.claudeCode.latest} is available; the image has{" "}
          {updates.claudeCode.image ?? "none"}.
        </div>
      )}
    </div>
  );
}
