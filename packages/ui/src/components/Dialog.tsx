// Modal dialogs and promise-based message boxes, the QDialog and QMessageBox
// of the Qt app.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface DialogProps {
  title: string;
  /** Called on Escape and on the backdrop; omit to make the dialog close only from its buttons. */
  onClose?: () => void;
  /** Called on Enter in a field, as the default button would be. */
  onSubmit?: () => void;
  /** The button row. */
  buttons?: ReactNode;
  children: ReactNode;
  width?: number | string;
  className?: string;
  /** Draws the dialog above message boxes, for a dialog that a message box button opens. */
  stacked?: boolean;
  /**
   * True while the dialog's request is in flight: every field and button is
   * disabled, and Enter submits nothing.
   */
  busy?: boolean;
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The open dialogs, innermost last; only the innermost one keeps focus. */
const openDialogs: HTMLElement[] = [];

function focusables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (x) => !x.hidden && x.getAttribute("aria-hidden") !== "true" && x.tabIndex >= 0,
  );
}

/**
 * Keeps Tab and Shift+Tab inside the innermost dialog, so that focus never
 * reaches the toolbar or a live terminal behind the backdrop.
 */
function trapTab(e: KeyboardEvent) {
  if (e.key !== "Tab" || e.defaultPrevented) return;
  const el = openDialogs[openDialogs.length - 1];
  if (!el) return;
  const list = focusables(el);
  const active = document.activeElement as HTMLElement | null;
  const i = active ? list.indexOf(active) : -1;
  let next: HTMLElement | undefined;
  if (list.length === 0) next = el;
  else if (i < 0) next = e.shiftKey ? list[list.length - 1] : list[0];
  else if (!e.shiftKey && i === list.length - 1) next = list[0];
  else if (e.shiftKey && i === 0) next = list[list.length - 1];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

/**
 * Runs one request at a time: `run(fn)` does nothing while an earlier call
 * is in flight, even when two Enter presses arrive before React renders.
 * `busy` is true while one runs; pass it to `Dialog`.
 */
export function useInFlight(): {
  busy: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
} {
  const [busy, setBusy] = useState(false);
  const flying = useRef(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (flying.current) return undefined;
    flying.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      flying.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

/**
 * A modal dialog. The first field, or the first button, takes focus when it
 * opens; Tab stays inside it; focus returns where it was when it closes.
 */
export function Dialog({
  title,
  onClose,
  onSubmit,
  buttons,
  children,
  width,
  className,
  stacked = false,
  busy = false,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    openDialogs.push(el);
    if (openDialogs.length === 1) document.addEventListener("keydown", trapTab, true);
    const first =
      el.querySelector<HTMLElement>("[data-autofocus]") ??
      el.querySelector<HTMLElement>(
        ".ab-dialog-body input:not(:disabled), .ab-dialog-body select:not(:disabled), .ab-dialog-body textarea:not(:disabled)",
      ) ??
      el.querySelector<HTMLElement>(".ab-dialog-buttons .ab-default") ??
      el.querySelector<HTMLElement>("button");
    first?.focus();
    return () => {
      const i = openDialogs.indexOf(el);
      if (i >= 0) openDialogs.splice(i, 1);
      if (openDialogs.length === 0) document.removeEventListener("keydown", trapTab, true);
      if (previous && previous.isConnected && previous !== document.body) previous.focus();
    };
  }, []);
  // Disabling the fields drops focus; it goes back to the same field after.
  const focusedBeforeBusy = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (busy) {
      const active = document.activeElement as HTMLElement | null;
      focusedBeforeBusy.current = active && el.contains(active) ? active : null;
      return;
    }
    const back = focusedBeforeBusy.current;
    focusedBeforeBusy.current = null;
    if (back && back.isConnected && !el.contains(document.activeElement)) back.focus();
  }, [busy]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && onClose) {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div
      className={`ab-dialog-backdrop${stacked ? " ab-stacked" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={`ab-dialog${className ? ` ${className}` : ""}`}
        style={width !== undefined ? { width } : undefined}
        onKeyDown={onKeyDown}
      >
        <div className="ab-dialog-title" id={titleId}>
          {title}
        </div>
        <form
          className="ab-dialog-form"
          style={{ display: "contents" }}
          onSubmit={(e) => {
            e.preventDefault();
            // A dialog opened from another dialog through a portal still
            // bubbles React events to it; keep Enter from submitting both.
            e.stopPropagation();
            if (!busy) onSubmit?.();
          }}
        >
          <fieldset className="ab-dialog-fieldset" disabled={busy}>
            <div className="ab-dialog-body">{children}</div>
            {buttons && <div className="ab-dialog-buttons">{buttons}</div>}
            {/* Lets Enter in a text field submit the form. */}
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </fieldset>
        </form>
      </div>
    </div>
  );
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Draws the accent border of the default button. */
  primary?: boolean;
}

export function Button({ primary, className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={`ab-button${primary ? " ab-default" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Message boxes

export interface MessageButton {
  id: string;
  label: string;
  primary?: boolean;
  /** Escape answers with this button. */
  cancel?: boolean;
  /**
   * Runs without closing the box, like the Qt app's "Rebuild Image..." button,
   * which opens the setup wizard over the prompt and leaves the prompt open.
   */
  onClick?: () => void;
}

export interface MessageOptions {
  title: string;
  text: string;
  /** Longer text, shown in monospace below `text`: lists of boxes or paths. */
  detail?: string;
  buttons: MessageButton[];
  /** An optional checkbox, such as "Also copy build output". */
  checkbox?: { label: string; checked: boolean };
}

export interface MessageResult {
  /** The id of the button that closed the box; the cancel button's id on Escape. */
  button: string;
  checked: boolean;
}

type Ask = (options: MessageOptions) => Promise<MessageResult>;

const MessageContext = createContext<Ask | null>(null);
const MessageOpenContext = createContext(false);

/** True while a message box is open; application chords stay off meanwhile. */
export function useMessageBoxOpen(): boolean {
  return useContext(MessageOpenContext);
}

interface Pending {
  /** Unique per request, so a queued request never reuses an open box's state. */
  id: number;
  options: MessageOptions;
  resolve: (r: MessageResult) => void;
}

/** Hosts the message boxes that `useMessageBox()` opens, one at a time. */
export function MessageBoxProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const nextId = useRef(0);
  const ask = useCallback<Ask>(
    (options) =>
      new Promise((resolve) => {
        const id = nextId.current++;
        setQueue((q) => [...q, { id, options, resolve }]);
      }),
    [],
  );
  const current = queue[0];
  return (
    <MessageContext.Provider value={ask}>
      <MessageOpenContext.Provider value={current !== undefined}>
        {children}
      </MessageOpenContext.Provider>
      {current && (
        <MessageBox
          key={current.id}
          options={current.options}
          onDone={(r) => {
            current.resolve(r);
            setQueue((q) => q.slice(1));
          }}
        />
      )}
    </MessageContext.Provider>
  );
}

function MessageBox({
  options,
  onDone,
}: {
  options: MessageOptions;
  onDone: (r: MessageResult) => void;
}) {
  const [checked, setChecked] = useState(options.checkbox?.checked ?? false);
  const cancel =
    options.buttons.find((b) => b.cancel) ?? options.buttons[options.buttons.length - 1];
  const primary = options.buttons.find((b) => b.primary);
  return (
    <Dialog
      title={options.title}
      onClose={() => onDone({ button: cancel?.id ?? "cancel", checked })}
      onSubmit={() => primary && onDone({ button: primary.id, checked })}
      buttons={options.buttons.map((b) => (
        <Button
          key={b.id}
          primary={b.primary}
          className={b.onClick ? "ab-left" : undefined}
          data-autofocus={b.primary ? true : undefined}
          onClick={() => (b.onClick ? b.onClick() : onDone({ button: b.id, checked }))}
        >
          {b.label}
        </Button>
      ))}
    >
      <div style={{ whiteSpace: "pre-wrap" }}>{options.text}</div>
      {options.detail && <div className="ab-message-detail">{options.detail}</div>}
      {options.checkbox && (
        <label className="ab-checkbox">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {options.checkbox.label}
        </label>
      )}
    </Dialog>
  );
}

/** Opens message boxes. Needs a `MessageBoxProvider`. */
export function useMessageBox() {
  const ask = useContext(MessageContext);
  if (!ask) throw new Error("useMessageBox needs a MessageBoxProvider.");
  return {
    ask,
    /** A Yes/No question; resolves true on Yes. `defaultNo` makes No the default button. */
    confirm: async (title: string, text: string, detail?: string, defaultNo = false) =>
      (
        await ask({
          title,
          text,
          detail,
          buttons: [
            { id: "yes", label: "Yes", primary: !defaultNo },
            { id: "no", label: "No", cancel: true, primary: defaultNo },
          ],
        })
      ).button === "yes",
    /** An information or warning box with an OK button. */
    inform: async (title: string, text: string, detail?: string) => {
      await ask({
        title,
        text,
        detail,
        buttons: [{ id: "ok", label: "OK", primary: true, cancel: true }],
      });
    },
  };
}
