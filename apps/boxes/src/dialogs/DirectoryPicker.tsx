// A directory picker for the browser, where there is no native dialog: it
// walks the host's directories through the server's `fs.dirs` route. In
// Electron, `useDirectoryPicker()` uses the native dialog from the bridge
// instead.
import type { DirListing } from "@agentbox/contracts";
import { Button, Dialog, errorMessage, useApiClient } from "@agentbox/ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { bridge } from "../bridge";

export interface DirectoryPickerProps {
  title?: string;
  /** The directory to open on; absent or missing opens the home directory. */
  initialPath?: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}

/** A modal that lists a directory's subdirectories and picks one. */
export function DirectoryPickerDialog(props: DirectoryPickerProps) {
  const client = useApiClient();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState(props.initialPath ?? "");
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(
    async (path: string | undefined, fallBackHome: boolean) => {
      try {
        const l = await client.call("fs.dirs", { query: path ? { path } : {} });
        setListing(l);
        setTyped(l.path);
        setError(null);
      } catch (err) {
        if (fallBackHome && path) {
          await open(undefined, false);
          return;
        }
        setError(errorMessage(err));
      }
    },
    [client],
  );

  useEffect(() => {
    void open(props.initialPath || undefined, true);
  }, [open, props.initialPath]);

  return createPortal(
    <Dialog
      title={props.title ?? "Choose a Directory"}
      width="min(560px, 94vw)"
      onClose={props.onCancel}
      onSubmit={() => void open(typed.trim() || undefined, false)}
      stacked
      buttons={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button primary disabled={!listing} onClick={() => listing && props.onPick(listing.path)}>
            Choose
          </Button>
        </>
      }
    >
      <div className="bx-row">
        <input
          className="ab-input bx-grow"
          aria-label="Path"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button onClick={() => void open(typed.trim() || undefined, false)}>Go</Button>
      </div>
      {error && (
        <div role="alert" className="ab-error-text">
          {error}
        </div>
      )}
      <ul className="bx-dir-list" aria-label="Subdirectories">
        {listing?.parent && (
          <li>
            <button
              type="button"
              className="bx-dir-entry"
              onClick={() => void open(listing.parent ?? undefined, false)}
            >
              ..
            </button>
          </li>
        )}
        {listing?.entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              className="bx-dir-entry"
              onDoubleClick={() => props.onPick(e.path)}
              onClick={() => void open(e.path, false)}
            >
              {e.name}/
            </button>
          </li>
        ))}
        {listing && listing.entries.length === 0 && <li className="bx-dim">No subdirectories.</li>}
      </ul>
    </Dialog>,
    document.body,
  );
}

/**
 * Picks a directory: the native dialog in Electron, else the `fs.dirs`
 * picker. Render `element` somewhere in the calling component.
 */
export function useDirectoryPicker(): {
  pick: (current?: string) => Promise<string | null>;
  element: ReactNode;
} {
  const [request, setRequest] = useState<{
    initial: string | undefined;
    resolve: (p: string | null) => void;
  } | null>(null);
  const pick = useCallback(async (current?: string) => {
    const b = bridge();
    if (b) return b.pickDirectory(current || undefined);
    return new Promise<string | null>((resolve) => setRequest({ initial: current, resolve }));
  }, []);
  const element = request ? (
    <DirectoryPickerDialog
      initialPath={request.initial}
      onPick={(p) => {
        request.resolve(p);
        setRequest(null);
      }}
      onCancel={() => {
        request.resolve(null);
        setRequest(null);
      }}
    />
  ) : null;
  return { pick, element };
}
