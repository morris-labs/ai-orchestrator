// A multi-line mounts editor, one `HOST[:CONTAINER]` per line: the global
// mounts and a project's mounts and TCP maps.
import type { Mount, TcpMap } from "@aio/contracts";
import { Button, Dialog, errorMessage } from "@aio/ui";
import { useState } from "react";
import { formatMount, parseMountText, tcpMapProblems, toTcpMaps } from "../logic/mounts";

export interface MountsDialogProps {
  title: string;
  intro: string;
  mounts: Mount[];
  /** When set, the dialog also edits TCP maps, one `HOST[:CONTAINER]` port pair per line. */
  tcpMaps?: TcpMap[];
  onSave: (value: { mounts: Mount[]; tcpMaps?: TcpMap[] }) => Promise<string | null>;
  onCancel: () => void;
}

/** Parses TCP map lines, `HOST[:CONTAINER]`. */
export function parseTcpText(text: string): { maps: TcpMap[]; problems: string[] } {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [host = "", container = ""] = l.split(":");
      return { host: host.trim(), container: container.trim() };
    });
  return { maps: toTcpMaps(rows), problems: tcpMapProblems(rows) };
}

export function MountsDialog(props: MountsDialogProps) {
  const [text, setText] = useState(props.mounts.map(formatMount).join("\n"));
  const [ports, setPorts] = useState(
    (props.tcpMaps ?? [])
      .map((m) => (m.host === m.container ? `${m.host}` : `${m.host}:${m.container}`))
      .join("\n"),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const { mounts, problems } = parseMountText(text);
    const tcp = props.tcpMaps ? parseTcpText(ports) : null;
    const all = [...problems, ...(tcp?.problems ?? [])];
    setErrors(all);
    if (all.length > 0) return;
    setBusy(true);
    try {
      const err = await props.onSave({ mounts, ...(tcp ? { tcpMaps: tcp.maps } : {}) });
      if (err) setErrors([err]);
    } catch (err) {
      setErrors([errorMessage(err)]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={props.title}
      width="min(680px, 94vw)"
      onClose={props.onCancel}
      buttons={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button primary disabled={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div>{props.intro}</div>
      <label className="bx-dim" htmlFor="bx-mounts">
        Mounts, one HOST[:CONTAINER] per line. The host folder must exist.
      </label>
      <textarea
        id="bx-mounts"
        className="ab-textarea"
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {props.tcpMaps && (
        <>
          <label className="bx-dim" htmlFor="bx-tcp">
            TCP maps, one HOST[:CONTAINER] port pair per line. Dev servers need none.
          </label>
          <textarea
            id="bx-tcp"
            className="ab-textarea"
            rows={4}
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
          />
        </>
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
