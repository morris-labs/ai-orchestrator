// Selection rules for the data table: click, Ctrl+click, Shift+click, and the
// arrow keys, in display order.

export interface SelectionState {
  selected: ReadonlySet<string>;
  /** The row a Shift+click range starts from. */
  anchor: string | null;
  /** The row the arrow keys move from, when it differs from the anchor. */
  focus?: string;
}

export type SelectGesture =
  | { kind: "click"; key: string; ctrl: boolean; shift: boolean }
  | { kind: "move"; delta: number; shift: boolean }
  | { kind: "all" };

/** Applies a gesture to the selection. `order` is the rows' keys in display order. */
export function applyGesture(
  state: SelectionState,
  gesture: SelectGesture,
  order: readonly string[],
): SelectionState {
  if (gesture.kind === "all")
    return { selected: new Set(order), anchor: state.anchor ?? order[0] ?? null };
  if (gesture.kind === "click") {
    const { key, ctrl, shift } = gesture;
    if (shift && state.anchor !== null && order.includes(state.anchor)) {
      return { selected: new Set(range(order, state.anchor, key)), anchor: state.anchor };
    }
    if (ctrl) {
      const next = new Set(state.selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { selected: next, anchor: key };
    }
    return { selected: new Set([key]), anchor: key };
  }
  if (order.length === 0) return state;
  const current = lastFocused(state, order);
  const index = current === null ? (gesture.delta > 0 ? -1 : order.length) : order.indexOf(current);
  const target = order[Math.max(0, Math.min(order.length - 1, index + gesture.delta))] as string;
  if (gesture.shift && state.anchor !== null && order.includes(state.anchor)) {
    return {
      selected: new Set(range(order, state.anchor, target)),
      anchor: state.anchor,
      focus: target,
    };
  }
  return { selected: new Set([target]), anchor: target };
}

function range(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return order.slice(lo, hi + 1);
}

function lastFocused(state: SelectionState, order: readonly string[]): string | null {
  if (state.focus && order.includes(state.focus)) return state.focus;
  if (state.anchor !== null && state.selected.has(state.anchor)) return state.anchor;
  const sel = order.filter((k) => state.selected.has(k));
  return sel[sel.length - 1] ?? null;
}
