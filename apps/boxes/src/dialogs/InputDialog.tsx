// A one-field dialog: rename a project, move or change a working directory,
// relink a box.
import { Button, Dialog, errorMessage } from "@agentbox/ui";
import { useState } from "react";
import { useDirectoryPicker } from "./DirectoryPicker";

export interface InputDialogProps {
  title: string;
  label: string;
  intro?: string;
  initial: string;
  placeholder?: string;
  /** Shows a Browse button that picks a directory: the native dialog in Electron, else `fs.dirs`. */
  browse?: boolean;
  /** Allows an empty value, as Rename does (empty means the folder name). */
  allowEmpty?: boolean;
  okLabel?: string;
  onAccept: (value: string) => Promise<string | null>;
  onCancel: () => void;
}

export function InputDialog(props: InputDialogProps) {
  const [value, setValue] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useDirectoryPicker();
  const accept = async () => {
    if (!props.allowEmpty && value.trim() === "") {
      setError(`Type a value for ${props.label.toLowerCase()}.`);
      return;
    }
    setBusy(true);
    try {
      setError(await props.onAccept(value.trim()));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={props.title}
      width="min(620px, 94vw)"
      onClose={props.onCancel}
      onSubmit={() => void accept()}
      buttons={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button primary disabled={busy} onClick={() => void accept()}>
            {props.okLabel ?? "OK"}
          </Button>
        </>
      }
    >
      {props.intro && <div style={{ whiteSpace: "pre-wrap" }}>{props.intro}</div>}
      <div className="ab-field">
        <label htmlFor="bx-input">{props.label}</label>
        <div className="bx-row">
          <input
            id="bx-input"
            className="ab-input bx-grow"
            value={value}
            placeholder={props.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
          {props.browse && (
            <Button
              onClick={async () => {
                const p = await picker.pick(value || undefined);
                if (p) setValue(p);
              }}
            >
              Browse...
            </Button>
          )}
          {picker.element}
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
