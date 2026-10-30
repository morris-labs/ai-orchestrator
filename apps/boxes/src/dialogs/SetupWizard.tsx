// The setup wizard: the host checks with their fixes, the image builds as
// streamed jobs, the default directory for New Box, and the 1Password
// reference of the containers' sudo password.
import type { Job, SetupCheck } from "@agentbox/contracts";
import { Button, Dialog, StatusDot, errorMessage, useApiClient } from "@agentbox/ui";
import { useCallback, useEffect, useState } from "react";
import { JobDialog } from "./JobDialog";

const checkTitles: Record<SetupCheck["id"], string> = {
  docker: "Docker reachable",
  image: "claude-code image",
  engine: "Engine version",
  ssh_client: "SSH client",
  ssh_key: "SSH keypair",
  ssh_permissions: "SSH permissions",
  op: "1Password CLI",
  sudo: "sudo in containers",
  service: "Server service",
};

const fixLabels: Partial<Record<SetupCheck["id"], string>> = {
  ssh_key: "Generate",
  ssh_permissions: "Fix",
  image: "Build Image",
  engine: "Rebuild Image",
  service: "Install",
};

export interface SetupWizardProps {
  onClose: () => void;
  /** Draws the dialog above an open message box. */
  stacked?: boolean;
  /** Called after Done saved the settings. */
  onDone?: () => void;
}

export function SetupWizard({ onClose, onDone, stacked }: SetupWizardProps) {
  const client = useApiClient();
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  const [dir, setDir] = useState("");
  // `null` until the settings load, so Done never clears a reference it hasn't seen.
  const [sudoRef, setSudoRef] = useState<string | null>(null);
  const [savedSudoRef, setSavedSudoRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<{ title: string; job: Job } | null>(null);

  const recheck = useCallback(() => {
    setChecks(null);
    client
      .call("setup.get", {})
      .then((s) => {
        setChecks(s.checks);
        setDir((d) => d || s.defaultTargetDir || "");
        setError(null);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [client]);

  useEffect(recheck, [recheck]);

  useEffect(() => {
    client
      .call("settings.get", {})
      .then((s) => {
        const ref = s.sudoPasswordRef ?? "";
        setSavedSudoRef(ref);
        setSudoRef((r) => r ?? ref);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [client]);

  const run = async (title: string, start: () => Promise<Job>) => {
    try {
      setJob({ title, job: await start() });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const build = (kind: "rebuild" | "packages" | "claude-code", title: string) =>
    run(title, () => client.call("image.build", { body: { kind } }));

  const done = async () => {
    try {
      const ref = sudoRef?.trim();
      if (ref !== undefined && ref !== savedSudoRef) {
        await client.call("settings.patch", { body: { sudoPasswordRef: ref || null } });
        setSavedSudoRef(ref);
      }
      await client.call("setup.complete", {
        body: dir.trim() ? { defaultTargetDir: dir.trim() } : {},
      });
      onDone?.();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (job) {
    return (
      <JobDialog
        stacked={stacked}
        title={job.title}
        job={job.job}
        onClose={() => {
          setJob(null);
          recheck();
        }}
      />
    );
  }

  return (
    <Dialog
      stacked={stacked}
      title="Setup"
      width="min(760px, 94vw)"
      onClose={onClose}
      buttons={
        <>
          <Button className="ab-left" onClick={recheck}>
            Recheck
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button primary onClick={() => void done()}>
            Done
          </Button>
        </>
      }
    >
      <div className="bx-dim">
        Agent Box checks what it needs on this computer. Fix anything marked red, then press Done.
      </div>
      {checks === null && !error && <div className="bx-dim">Checking...</div>}
      {checks?.map((c) => (
        <div key={c.id} className="bx-check" aria-label={checkTitles[c.id]}>
          <StatusDot
            state={c.status === "ok" ? "running" : c.status === "warn" ? "pending" : "stopped"}
            title={c.status}
          />
          <div className="bx-grow">
            <div>{checkTitles[c.id]}</div>
            <div className="bx-dim">{c.message}</div>
          </div>
          {c.id === "image" ? (
            <>
              <Button onClick={() => void build("packages", "Update Packages")}>
                Update Packages
              </Button>
              <Button onClick={() => void build("claude-code", "Update Claude Code")}>
                Update Claude Code
              </Button>
              <Button onClick={() => void build("rebuild", "Build Image")}>
                {c.status === "ok" ? "Rebuild Image" : "Build Image"}
              </Button>
            </>
          ) : (
            c.fixable &&
            c.status !== "ok" && (
              <Button
                onClick={() =>
                  void run(`${fixLabels[c.id] ?? "Fix"}: ${checkTitles[c.id]}`, () =>
                    client.call("setup.fix", { params: { checkId: c.id } }),
                  )
                }
              >
                {fixLabels[c.id] ?? "Fix"}
              </Button>
            )
          )}
        </div>
      ))}
      <div className="ab-field">
        <label htmlFor="bx-default-dir">Default directory for New Box</label>
        <input
          id="bx-default-dir"
          className="ab-input"
          value={dir}
          placeholder="/home/you/projects"
          onChange={(e) => setDir(e.target.value)}
        />
      </div>
      <div className="ab-field">
        <label htmlFor="bx-sudo-ref">Sudo password reference (1Password)</label>
        <input
          id="bx-sudo-ref"
          className="ab-input"
          value={sudoRef ?? ""}
          disabled={sudoRef === null}
          placeholder="op://VAULT/ITEM/FIELD"
          onChange={(e) => setSudoRef(e.target.value)}
        />
        <div className="bx-dim">
          Leave this empty to turn sudo off in containers. With a reference, sudo asks for that
          password every time; containers get only its hash. Restart running project containers to
          apply a change.
        </div>
      </div>
      {error && (
        <div role="alert" className="ab-error-text">
          {error}
        </div>
      )}
    </Dialog>
  );
}
