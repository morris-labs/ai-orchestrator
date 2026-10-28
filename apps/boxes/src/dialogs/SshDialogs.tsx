// SSH remotes: the manager list and the remote editor with Test Connection
// and the ssh-copy-id job.
import type { Job, SshForward, SshRemote } from "@agentbox/contracts";
import { Button, Dialog, errorMessage, useApiClient, useMessageBox } from "@agentbox/ui";
import { useCallback, useEffect, useState } from "react";
import { rowsToForwards, validTarget, type ForwardRow } from "../logic/ssh";
import { JobDialog } from "./JobDialog";

interface RemoteRow {
  remote: SshRemote;
  referencedBy: string[];
  tunnelUp: boolean;
  tunnelError: string | null;
}

export function SshRemotesDialog({ onClose }: { onClose: () => void }) {
  const client = useApiClient();
  const { confirm } = useMessageBox();
  const [rows, setRows] = useState<RemoteRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<SshRemote | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    client
      .call("sshRemotes.list", {})
      .then((r) => setRows(r.remotes))
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [client]);
  useEffect(load, [load]);

  const remove = async () => {
    const row = rows.find((r) => r.remote.name === selected);
    if (!row) return;
    const users = row.referencedBy.length
      ? `\n\nThese boxes use it and lose the forward:\n  ${row.referencedBy.join("\n  ")}`
      : "";
    if (!(await confirm("Manage SSH Remotes", `Remove the remote "${row.remote.name}"?${users}`)))
      return;
    try {
      await client.call("sshRemotes.delete", { params: { name: row.remote.name } });
      setSelected(null);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (editing) {
    return (
      <SshRemoteDialog
        remote={editing === "new" ? null : editing}
        taken={rows.map((r) => r.remote.name)}
        onClose={() => {
          setEditing(null);
          load();
        }}
      />
    );
  }

  const current = rows.find((r) => r.remote.name === selected);
  return (
    <Dialog
      title="Manage SSH Remotes"
      width="min(620px, 94vw)"
      onClose={onClose}
      buttons={
        <>
          <Button className="ab-left" onClick={() => setEditing("new")}>
            Add...
          </Button>
          <Button disabled={!current} onClick={() => current && setEditing(current.remote)}>
            Edit...
          </Button>
          <Button disabled={!current} onClick={() => void remove()}>
            Remove
          </Button>
          <Button primary onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="bx-listbox" role="listbox" aria-label="SSH remotes">
        {rows.length === 0 && (
          <div className="bx-dim">No remotes yet. Add one to forward ports over SSH.</div>
        )}
        {rows.map((r) => (
          <div
            key={r.remote.name}
            role="option"
            aria-selected={selected === r.remote.name}
            className={`bx-project${selected === r.remote.name ? " bx-active" : ""}`}
            onClick={() => setSelected(r.remote.name)}
            onDoubleClick={() => setEditing(r.remote)}
          >
            {r.remote.name} {"—"} {r.remote.host} ({r.remote.forwards.length} forwards)
          </div>
        ))}
      </div>
      {error && (
        <div role="alert" className="ab-error-text">
          {error}
        </div>
      )}
    </Dialog>
  );
}

function toRows(forwards: readonly SshForward[]): ForwardRow[] {
  return forwards.map((f) => ({
    direction: f.direction,
    bindAddress: f.bindAddress,
    bindPort: String(f.bindPort),
    destHost: f.destHost,
    destPort: String(f.destPort),
  }));
}

export interface SshRemoteDialogProps {
  remote: SshRemote | null;
  taken: string[];
  onClose: () => void;
}

/** Problems with the remote form. */
export function remoteProblems(
  name: string,
  host: string,
  oldName: string | null,
  taken: readonly string[],
): string[] {
  const out: string[] = [];
  if (name.trim() === "") out.push("Type a name.");
  else if (name.trim() !== oldName && taken.includes(name.trim()))
    out.push(`A remote named ${name.trim()} exists.`);
  if (!validTarget(host)) out.push("The SSH target must look like user@host or user@host:port.");
  return out;
}

export function SshRemoteDialog({ remote, taken, onClose }: SshRemoteDialogProps) {
  const client = useApiClient();
  const { ask } = useMessageBox();
  const [name, setName] = useState(remote?.name ?? "");
  const [host, setHost] = useState(remote?.host ?? "");
  const [identity, setIdentity] = useState(remote?.identity ?? "");
  const [rows, setRows] = useState<ForwardRow[]>(toRows(remote?.forwards ?? []));
  const [errors, setErrors] = useState<string[]>([]);
  const [test, setTest] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  const build = (): SshRemote | null => {
    const { forwards, problems } = rowsToForwards(rows);
    const all = [...remoteProblems(name, host, remote?.name ?? null, taken), ...problems];
    setErrors(all);
    if (all.length > 0) return null;
    return {
      name: name.trim(),
      host: host.trim(),
      ...(identity.trim() ? { identity: identity.trim() } : {}),
      forwards,
    };
  };

  const save = async (): Promise<SshRemote | null> => {
    const r = build();
    if (!r) return null;
    try {
      await client.call("sshRemotes.put", { params: { name: remote?.name ?? r.name }, body: r });
      return r;
    } catch (err) {
      setErrors([errorMessage(err)]);
      return null;
    }
  };

  const testConnection = async () => {
    const r = build();
    if (!r) return;
    setTest("Testing...");
    try {
      const res = await client.call("sshRemotes.test", {
        params: { name: remote?.name ?? r.name },
        body: r,
      });
      setTest(res.ok ? "Connected." : res.output || "The connection failed.");
      if (!res.ok && res.authFailed) {
        const answer = await ask({
          title: "Test Connection",
          text: `${r.host} refused the key. Copy your public key to it with ssh-copy-id? The remote is saved first, and you type the password in the terminal.`,
          buttons: [
            { id: "copy", label: "Copy Key", primary: true },
            { id: "cancel", label: "Cancel", cancel: true },
          ],
        });
        if (answer.button !== "copy") return;
        const saved = await save();
        if (!saved) return;
        setJob(await client.call("sshRemotes.copyId", { params: { name: saved.name } }));
      }
    } catch (err) {
      setTest(errorMessage(err));
    }
  };

  if (job) return <JobDialog title="ssh-copy-id" job={job} onClose={() => setJob(null)} />;

  return (
    <Dialog
      title={remote ? `Edit SSH Remote` : "Add SSH Remote"}
      width="min(780px, 94vw)"
      onClose={onClose}
      buttons={
        <>
          <Button className="ab-left" onClick={() => void testConnection()}>
            Test Connection
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button primary onClick={() => void save().then((r) => r && onClose())}>
            Save
          </Button>
        </>
      }
    >
      <div className="ab-field">
        <label htmlFor="ssh-name">Name</label>
        <input
          id="ssh-name"
          className="ab-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="ab-field">
        <label htmlFor="ssh-host">SSH target</label>
        <input
          id="ssh-host"
          className="ab-input"
          placeholder="user@host[:port]"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        />
      </div>
      <div className="ab-field">
        <label htmlFor="ssh-identity">Identity file</label>
        <input
          id="ssh-identity"
          className="ab-input"
          placeholder="~/.ssh/id_ed25519 (optional)"
          value={identity}
          onChange={(e) => setIdentity(e.target.value)}
        />
      </div>
      <div className="bx-dim">
        Forwards: L forwards a port on this computer to the remote side; R forwards a remote port
        back here.
      </div>
      {rows.map((r, i) => (
        <div key={i} className="bx-row">
          <select
            className="ab-select"
            aria-label={`Direction ${i + 1}`}
            value={r.direction}
            onChange={(e) =>
              setRows((all) =>
                all.map((x, j) => (j === i ? { ...x, direction: e.target.value as "L" | "R" } : x)),
              )
            }
          >
            <option value="L">L</option>
            <option value="R">R</option>
          </select>
          {(["bindAddress", "bindPort", "destHost", "destPort"] as const).map((k) => (
            <input
              key={k}
              className="ab-input bx-grow"
              aria-label={`${k} ${i + 1}`}
              placeholder={
                {
                  bindAddress: "localhost",
                  bindPort: "bind port",
                  destHost: "destination host",
                  destPort: "port",
                }[k]
              }
              value={r[k]}
              onChange={(e) =>
                setRows((all) => all.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))
              }
            />
          ))}
          <Button onClick={() => setRows((all) => all.filter((_x, j) => j !== i))}>Remove</Button>
        </div>
      ))}
      <div>
        <Button
          onClick={() =>
            setRows((all) => [
              ...all,
              {
                direction: "L",
                bindAddress: "localhost",
                bindPort: "",
                destHost: "localhost",
                destPort: "",
              },
            ])
          }
        >
          Add forward
        </Button>
      </div>
      {test && (
        <div className="ab-message-detail" role="status">
          {test}
        </div>
      )}
      {errors.length > 0 && (
        <div role="alert" className="ab-error-text">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
