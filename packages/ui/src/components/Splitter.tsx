// A resizable split between panes: the QSplitter of the main window. Sizes
// are fractions, remembered per `storageKey` in this browser's local storage.
import { Children, useRef, useState, type ReactNode } from "react";

function loadSizes(key: string | undefined, count: number): number[] | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(`ab.splitter.${key}`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      Array.isArray(parsed) &&
      parsed.length === count &&
      parsed.every((n) => typeof n === "number" && n > 0)
    ) {
      return parsed as number[];
    }
  } catch {
    // Storage can be unavailable; fall back to the defaults.
  }
  return null;
}

function saveSizes(key: string | undefined, sizes: number[]) {
  if (!key) return;
  try {
    localStorage.setItem(`ab.splitter.${key}`, JSON.stringify(sizes));
  } catch {
    // Storage can be unavailable.
  }
}

/** Moves the boundary after pane `index` by `delta` (a fraction), keeping each pane at `min` or more. */
export function resizePanes(
  sizes: readonly number[],
  index: number,
  delta: number,
  min = 0.05,
): number[] {
  const next = [...sizes];
  const a = next[index] ?? 0;
  const b = next[index + 1] ?? 0;
  const d = Math.max(min - a, Math.min(b - min, delta));
  next[index] = a + d;
  next[index + 1] = b - d;
  return next;
}

export interface SplitterProps {
  direction: "horizontal" | "vertical";
  /** Starting fractions, one per child. */
  defaultSizes: number[];
  storageKey?: string;
  /**
   * Smallest size in pixels for each child, along the split. A saved or
   * dragged fraction can't push a pane below it, so a pane that needs room
   * to be usable, such as a terminal, always keeps it. Missing entries and 0
   * mean no minimum.
   */
  minSizes?: number[];
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Splitter({
  direction,
  defaultSizes,
  storageKey,
  minSizes,
  children,
  className,
  style,
}: SplitterProps) {
  const panes = Children.toArray(children).filter(Boolean);
  const [sizes, setSizes] = useState<number[]>(
    () => loadSizes(storageKey, panes.length) ?? normalize(defaultSizes, panes.length),
  );
  const ref = useRef<HTMLDivElement>(null);
  const current = sizes.length === panes.length ? sizes : normalize(defaultSizes, panes.length);

  const startDrag = (index: number, e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const total = direction === "horizontal" ? rect.width : rect.height;
    const start = direction === "horizontal" ? e.clientX : e.clientY;
    const base = current;
    let latest = base;
    const move = (ev: PointerEvent) => {
      const pos = direction === "horizontal" ? ev.clientX : ev.clientY;
      latest = resizePanes(base, index, total > 0 ? (pos - start) / total : 0);
      setSizes(latest);
    };
    // Pointer capture keeps the events coming when the pointer leaves the
    // window. A cancelled pointer, or a capture lost some other way, ends
    // the drag too, so the panes never keep following a released pointer.
    const handle = e.currentTarget as Element;
    let ended = false;
    const up = () => {
      if (ended) return;
      ended = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      handle.removeEventListener("lostpointercapture", up);
      saveSizes(storageKey, latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    try {
      handle.setPointerCapture?.(e.pointerId);
      handle.addEventListener("lostpointercapture", up);
    } catch {
      // No capture for this pointer; pointerup and pointercancel still end the drag.
    }
  };

  return (
    <div
      ref={ref}
      className={`ab-splitter ab-${direction}${className ? ` ${className}` : ""}`}
      style={style}
    >
      {panes.map((pane, i) => (
        <SplitPart
          key={i}
          index={i}
          size={current[i] ?? 0}
          minSize={minSizes?.[i] ?? 0}
          last={i === panes.length - 1}
          onDrag={startDrag}
          direction={direction}
        >
          {pane}
        </SplitPart>
      ))}
    </div>
  );
}

function SplitPart({
  index,
  size,
  minSize,
  last,
  onDrag,
  direction,
  children,
}: {
  index: number;
  size: number;
  minSize: number;
  last: boolean;
  onDrag: (index: number, e: React.PointerEvent) => void;
  direction: "horizontal" | "vertical";
  children: ReactNode;
}) {
  return (
    <>
      <div
        className="ab-splitter-pane"
        style={{
          flex: `${size} 1 0px`,
          ...(minSize > 0
            ? direction === "horizontal"
              ? { minWidth: minSize }
              : { minHeight: minSize }
            : {}),
        }}
      >
        {children}
      </div>
      {!last && (
        <div
          className="ab-splitter-handle"
          role="separator"
          aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
          onPointerDown={(e) => onDrag(index, e)}
        />
      )}
    </>
  );
}

function normalize(sizes: number[], count: number): number[] {
  const out = Array.from({ length: count }, (_, i) => sizes[i] ?? 1);
  const sum = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((s) => s / sum);
}
