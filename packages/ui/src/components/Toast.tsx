// Short-lived messages in the corner, in place of the Qt status-bar messages.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export type ToastKind = "info" | "success" | "error";

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

type ShowToast = (text: string, options?: { kind?: ToastKind; timeoutMs?: number }) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = (id: number) => setItems((all) => all.filter((t) => t.id !== id));
  const show = useCallback<ShowToast>((text, options = {}) => {
    const id = next.current++;
    const kind = options.kind ?? "info";
    setItems((all) => [...all.slice(-4), { id, text, kind }]);
    const timeout = options.timeoutMs ?? (kind === "error" ? 10_000 : 5_000);
    if (timeout > 0) setTimeout(() => dismiss(id), timeout);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="ab-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`ab-toast ab-${t.kind}`}>
            <span className="ab-toast-text">{t.text}</span>
            <button
              type="button"
              className="ab-tab-close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              {"×"}
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Returns the function that shows a toast. Needs a `ToastProvider`. */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast needs a ToastProvider.");
  return show;
}
