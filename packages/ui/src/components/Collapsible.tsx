// A section with a header that shows or hides its body, as the New Box
// dialog's port, remote, and folder sections did.
import { useId, useState, type ReactNode } from "react";

export function Collapsible({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="ab-collapsible">
      <button
        type="button"
        className="ab-collapsible-header"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾" : "▸"} {title}
      </button>
      {open && (
        <div id={id} className="ab-collapsible-body">
          {children}
        </div>
      )}
    </div>
  );
}
