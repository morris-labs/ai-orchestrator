// The setup wizard: the host checks with their fixes, the image builds as
// streamed jobs, this machine's multi-host role (a single machine, a hub, or
// a node that joins a hub with an enrollment code), the default directory for New
// Box, and the 1Password reference of the containers' sudo password.
import type { Job, NodeStatus, SetupCheck } from "@aio/contracts";
import { Button, Dialog, StatusDot, errorMessage, useApiClient } from "@aio/ui";
import { useCallback, useEffect, useState } from "react";
import { parseJoinInput } from "../logic/machines";
import { JobDialog } from "./JobDialog";

/**
 * What the user picks for this machine: on its own (role `both`), a hub that
 * only coordinates nodes (role `hub`), or a node of a hub.
 */
type MachineChoice = "single" | "hub" | "join";

/** The choice that matches a role. */
function choiceFor(role: NodeStatus["role"]): MachineChoice {
  return role === "node" ? "join" : role === "hub" ? "hub" : "single";
}

const checkTitles: Record<SetupCheck["id"], string> = {
  docker: "Docker reachable",
  image: "aio-agent image",
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
  // `null` while loading or when the server has no multi-host routes; the
  // wizard then hides the role section.
  const [node, setNode] = useState<NodeStatus | null>(null);
  const [choice, setChoice] = useState<MachineChoice>("single");
  const [hubUrl, setHubUrl] = useState("");
  const [code, setCode] = useState("");
  const [machineName, setMachineName] = useState("");
  // True while Done runs. A second run could spend the code twice.
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    client
      .call("node.get", {})
      .then((s) => {
        setNode(s);
        setChoice(choiceFor(s.role));
      })
      .catch(() => setNode(null));
  }, [client]);

  /** True when the wizard offers the role choice: this machine hasn't joined a hub. */
  const canChoose = node !== null && node.hubUrl === null;

  /** Stores the chosen role, or joins the hub. */
  const applyRole = async (): Promise<void> => {
    if (!canChoose || node === null) return;
    if (choice !== "join") {
      const role = choice === "hub" ? "hub" : "both";
      // A stored role has no effect under an override.
      if (node.role !== role && !node.roleOverride) {
        await client.call("settings.patch", { body: { role } });
        setNode({ ...node, role });
      }
      return;
    }
    const target = parseJoinInput(hubUrl);
    if (!target) {
      throw new Error(
        "Enter the hub URL that came with the enrollment code, such as https://hub.example.com:21402.",
      );
    }
    const joinCode = code.trim() || target.code;
    if (!joinCode) throw new Error("Enter the enrollment code from the hub.");
    const name = machineName.trim();
    setNode(
      await client.call("node.join", {
        body: {
          hubUrl: target.hubUrl,
          code: joinCode,
          ...(name ? { name } : {}),
          // A hub can't join another hub, so the server changes its role when the join succeeds.
          ...(node.role === "hub" ? { leaveHubRole: true } : {}),
        },
      }),
    );
  };

  /** Takes the hub URL, and a code if one follows it, from a pasted join command. */
  const changeHubUrl = (value: string) => {
    const parsed = parseJoinInput(value);
    setHubUrl(parsed?.hubUrl ?? value);
    if (parsed?.code) setCode(parsed.code);
  };

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
    setSaving(true);
    try {
      await applyRole();
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
    } finally {
      setSaving(false);
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
          <Button primary disabled={saving} onClick={() => void done()}>
            Done
          </Button>
        </>
      }
    >
      <div className="bx-dim">
        AI Orchestrator checks what it needs on this computer. Fix anything marked red, then press
        Done.
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
      {node !== null && (
        <MachineRoleSection
          node={node}
          canChoose={canChoose}
          choice={choice}
          setChoice={setChoice}
          hubUrl={hubUrl}
          setHubUrl={changeHubUrl}
          code={code}
          setCode={setCode}
          machineName={machineName}
          setMachineName={setMachineName}
        />
      )}
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

interface MachineRoleSectionProps {
  node: NodeStatus;
  canChoose: boolean;
  choice: MachineChoice;
  setChoice: (c: MachineChoice) => void;
  hubUrl: string;
  setHubUrl: (v: string) => void;
  code: string;
  setCode: (v: string) => void;
  machineName: string;
  setMachineName: (v: string) => void;
}

/** This machine's role: a summary once it joined a hub, else the choice. */
function MachineRoleSection(p: MachineRoleSectionProps) {
  const { node } = p;
  const override = node.roleOverride;
  if (node.hubUrl !== null) {
    return (
      <div className="ab-field" aria-label="This machine">
        <div>This machine</div>
        <div className="bx-dim">
          {`A node of the hub at ${node.hubUrl}, as ${node.name}. Link: ${node.link}.`}
          {node.error ? ` ${node.error}` : ""}
        </div>
      </div>
    );
  }
  if (!p.canChoose) return null;
  return (
    <div className="ab-field" role="group" aria-label="This machine">
      <div>This machine</div>
      <label className="ab-checkbox">
        <input
          type="radio"
          name="bx-machine-role"
          value="single"
          checked={p.choice === "single"}
          onChange={() => p.setChoice("single")}
        />
        Single machine: run boxes on this computer, and share them as the hub when you add machines
      </label>
      <label className="ab-checkbox">
        <input
          type="radio"
          name="bx-machine-role"
          value="hub"
          checked={p.choice === "hub"}
          onChange={() => p.setChoice("hub")}
        />
        Hub: coordinate other machines, and keep this computer&apos;s boxes to itself
      </label>
      <label className="ab-checkbox">
        <input
          type="radio"
          name="bx-machine-role"
          value="join"
          checked={p.choice === "join"}
          onChange={() => p.setChoice("join")}
        />
        Node: join a hub with an enrollment code
      </label>
      {override && (
        <div className="bx-dim">
          This server runs with --role {override} or AIO_ROLE={override}, so Done doesn&apos;t
          change its role. To use another role, start the server without that override.
        </div>
      )}
      {p.choice === "single" && node.role !== "both" && !override && (
        <div className="bx-dim">
          This server runs as a {node.role}. Done sets its role to both, which applies at once.
        </div>
      )}
      {p.choice === "hub" && (
        <div className="bx-dim">
          A hub enrolls nodes and relays between them, and never joins another hub. Nodes can&apos;t
          see or reach boxes on a hub; to share this computer&apos;s boxes with them, choose Single
          machine. To add a machine, issue an enrollment code on the Machines page.
          {node.role !== "hub" &&
            !override &&
            " Done sets the role to hub, which applies at once."}
        </div>
      )}
      {p.choice === "join" && (
        <>
          <label htmlFor="bx-hub-url">Hub URL</label>
          <input
            id="bx-hub-url"
            className="ab-input"
            value={p.hubUrl}
            placeholder="https://hub.example.com:21402"
            onChange={(e) => p.setHubUrl(e.target.value)}
          />
          <label htmlFor="bx-enroll-code">Enrollment code</label>
          <input
            id="bx-enroll-code"
            className="ab-input"
            value={p.code}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => p.setCode(e.target.value)}
          />
          <label htmlFor="bx-machine-name">Machine name (optional)</label>
          <input
            id="bx-machine-name"
            className="ab-input"
            value={p.machineName}
            placeholder={node.name}
            onChange={(e) => p.setMachineName(e.target.value)}
          />
          <div className="bx-dim">
            On the hub, issue a code on the Machines page or with aio machines enroll. You can paste
            the aio node join command into Hub URL. Done joins the hub; the code works once.
          </div>
        </>
      )}
    </div>
  );
}
