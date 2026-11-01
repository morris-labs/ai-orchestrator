// A Paste button for path fields, shown beside a Browse button.
import { Button } from "@aio/ui";
import { bridge } from "../bridge";
import { cleanPastedPath } from "../logic/mounts";

/**
 * Reads the clipboard's plain text: through the Electron bridge, else the
 * browser's clipboard API. Returns an empty string when neither can read it.
 */
export async function readClipboardText(): Promise<string> {
  try {
    const b = bridge();
    if (b) return await b.readClipboardText();
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

export interface PasteButtonProps {
  /** The field's name for the accessible label, such as `host folder 1`. */
  field: string;
  /** Receives the cleaned path; not called when the clipboard holds no text. */
  onPaste: (path: string) => void;
}

export function PasteButton({ field, onPaste }: PasteButtonProps) {
  return (
    <Button
      aria-label={`Paste ${field} from the clipboard`}
      title="Paste a path from the clipboard"
      onClick={async () => {
        const path = cleanPastedPath(await readClipboardText());
        if (path) onPaste(path);
      }}
    >
      Paste
    </Button>
  );
}
