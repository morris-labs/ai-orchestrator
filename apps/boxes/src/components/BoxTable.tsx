// The box table: Status, Directory, Conversation, and Container, sortable,
// multi-select, with a context menu and double-click.
import type { BoxView } from "@aio/contracts";
import { DataTable, StatusDot, type Column, type SortState } from "@aio/ui";
import { boxWorkDir } from "@aio/contracts";
import { displayName, statusDot, statusLabel, statusRank } from "../logic/status";

export const EMPTY_TEXT = "No boxes yet. Use New Box (Ctrl+Shift+N) to start one.";

export const boxColumns: Column<BoxView>[] = [
  {
    id: "status",
    header: "Status",
    width: 130,
    sortValue: (b) => statusRank[b.status],
    render: (b) => (
      <span className="bx-status">
        <StatusDot state={statusDot[b.status]} title={statusLabel[b.status]} />
        {statusLabel[b.status]}
        {b.reviewState.state === "under_review" && <span className="bx-badge">under review</span>}
      </span>
    ),
  },
  {
    id: "dir",
    header: "Directory",
    sortValue: (b) => boxWorkDir(b.box),
    render: (b) => (
      <>
        {boxWorkDir(b.box)}
        {!b.targetDirExists && <span className="bx-missing">[missing]</span>}
      </>
    ),
  },
  {
    id: "conversation",
    header: "Conversation",
    sortValue: (b) => displayName(b),
    render: (b) => displayName(b),
  },
  {
    id: "container",
    header: "Container",
    sortValue: (b) => b.box.id,
    render: (b) => <span className="bx-dim">{b.box.id}</span>,
  },
];

export interface BoxTableProps {
  rows: BoxView[];
  selected: ReadonlySet<string>;
  onSelectionChange: (s: Set<string>) => void;
  onActivate: (b: BoxView) => void;
  onContextMenu: (b: BoxView | null, x: number, y: number) => void;
  sort: SortState;
  onSortChange: (s: SortState) => void;
}

const rowKey = (b: BoxView) => b.box.id;
const rowTitle = (b: BoxView) =>
  `${b.box.id}\n${b.box.targetDir}${b.targetDirExists ? "" : " (missing)"}${
    b.box.branch ? `\nbranch ${b.box.branch}` : ""
  }`;

export function BoxTable(props: BoxTableProps) {
  return (
    <DataTable
      label="Boxes"
      rows={props.rows}
      rowKey={rowKey}
      rowTitle={rowTitle}
      columns={boxColumns}
      selected={props.selected}
      onSelectionChange={props.onSelectionChange}
      onActivate={props.onActivate}
      onContextMenu={props.onContextMenu}
      emptyText={EMPTY_TEXT}
      sort={props.sort}
      onSortChange={props.onSortChange}
    />
  );
}
