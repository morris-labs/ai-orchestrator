// A sortable, multi-select table: the QTableView of the box list.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { applyGesture, type SelectGesture, type SelectionState } from "./selection";

export interface Column<T> {
  id: string;
  header: string;
  render: (row: T) => ReactNode;
  /** The value the column sorts by; columns without one don't sort. */
  sortValue?: (row: T) => string | number;
  width?: number | string;
}

export interface SortState {
  column: string;
  direction: "asc" | "desc";
}

export interface DataTableProps<T> {
  rows: readonly T[];
  rowKey: (row: T) => string;
  columns: Column<T>[];
  selected: ReadonlySet<string>;
  onSelectionChange: (selected: Set<string>) => void;
  /** Double-click or Enter on a row. */
  onActivate?: (row: T) => void;
  /** Right-click; `row` is `null` on empty space. The selection already includes the row. */
  onContextMenu?: (row: T | null, x: number, y: number) => void;
  emptyText?: string;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  rowTitle?: (row: T) => string | undefined;
  label?: string;
}

/** Sorts rows by a column's `sortValue`; ties keep their order. */
export function sortRows<T>(
  rows: readonly T[],
  columns: Column<T>[],
  sort: SortState | undefined,
): T[] {
  const col = sort ? columns.find((c) => c.id === sort.column) : undefined;
  if (!col?.sortValue || !sort) return [...rows];
  const sign = sort.direction === "asc" ? 1 : -1;
  const value = col.sortValue;
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      const c =
        typeof a.v === "number" && typeof b.v === "number"
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), undefined, {
              sensitivity: "base",
              numeric: true,
            });
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}

export function DataTable<T>(props: DataTableProps<T>) {
  const { rows, rowKey, columns, selected, onSelectionChange, onActivate, onContextMenu } = props;
  const [internalSort, setInternalSort] = useState<SortState | undefined>(props.sort);
  const sort = props.sort ?? internalSort;
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
  const order = useMemo(() => sorted.map(rowKey), [sorted, rowKey]);
  const anchor = useRef<SelectionState>({ selected, anchor: null });

  const apply = (gesture: SelectGesture) => {
    const next = applyGesture({ ...anchor.current, selected }, gesture, order);
    anchor.current = next;
    onSelectionChange(new Set(next.selected));
  };

  const setSort = (column: Column<T>) => {
    if (!column.sortValue) return;
    const next: SortState =
      sort?.column === column.id
        ? { column: column.id, direction: sort.direction === "asc" ? "desc" : "asc" }
        : { column: column.id, direction: "asc" };
    setInternalSort(next);
    props.onSortChange?.(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      apply({ kind: "move", delta: e.key === "ArrowDown" ? 1 : -1, shift: e.shiftKey });
    } else if (e.key === "a" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      apply({ kind: "all" });
    } else if (e.key === "Enter" && onActivate) {
      const first = sorted.find((r) => selected.has(rowKey(r)));
      if (first) onActivate(first);
    }
  };

  return (
    <div
      className="ab-table-wrap"
      onContextMenu={(e) => {
        if (e.target === e.currentTarget && onContextMenu) {
          e.preventDefault();
          onContextMenu(null, e.clientX, e.clientY);
        }
      }}
    >
      <table
        className="ab-table"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label={props.label}
        aria-multiselectable="true"
      >
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.id}
                style={c.width !== undefined ? { width: c.width } : undefined}
                aria-sort={
                  sort?.column === c.id
                    ? sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                onClick={() => setSort(c)}
              >
                {c.header}
                {sort?.column === c.id ? (sort.direction === "asc" ? " ▴" : " ▾") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            const isSel = selected.has(key);
            return (
              <tr
                key={key}
                className={isSel ? "ab-selected" : undefined}
                aria-selected={isSel}
                title={props.rowTitle?.(row)}
                data-key={key}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  apply({ kind: "click", key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
                }}
                onDoubleClick={() => onActivate?.(row)}
                onContextMenu={(e) => {
                  if (!onContextMenu) return;
                  e.preventDefault();
                  if (!isSel) apply({ kind: "click", key, ctrl: false, shift: false });
                  onContextMenu(row, e.clientX, e.clientY);
                }}
              >
                {columns.map((c) => (
                  <td key={c.id}>{c.render(row)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && props.emptyText && (
        <div className="ab-table-empty">{props.emptyText}</div>
      )}
    </div>
  );
}
