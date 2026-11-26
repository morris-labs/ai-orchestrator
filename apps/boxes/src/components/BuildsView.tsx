// The Builds page: the machine's builds, newest first, with each build's
// state, step, open escalations, project, and last change. Selecting a build shows the detail
// that the caller renders beside the list.
import type { BuildSummary, PmItem, ProjectSummary } from "@aio/contracts";
import { DataTable, type Column, type SortState } from "@aio/ui";
import { useMemo, useState, type ReactNode } from "react";
import { buildStateLabel, stepLabel } from "../logic/builds";
import { relativeTime } from "../logic/format";

export const BUILDS_EMPTY_TEXT =
  "No builds yet. A Project manager starts one with the aio-build command.";

export interface BuildsViewProps {
  /** Newest first. */
  builds: readonly BuildSummary[];
  projects: readonly ProjectSummary[];
  /** The selected build's id, or `null`. */
  selectedId: string | null;
  onSelect: (buildId: string | null) => void;
  /** Why the list failed to load, or `null`. */
  error?: string | null;
  /** The detail of the selected build, shown beside the list. */
  detail?: (build: BuildSummary) => ReactNode;
  /** Each build's open escalations, by build id. */
  escalations?: ReadonlyMap<string, readonly PmItem[]>;
}

function buildColumns(
  projectName: (id: string) => string,
  openCount: (id: string) => number,
): Column<BuildSummary>[] {
  return [
    {
      id: "state",
      header: "State",
      width: 130,
      sortValue: buildStateLabel,
      render: buildStateLabel,
    },
    { id: "build", header: "Build", sortValue: (b) => b.slug, render: (b) => b.slug },
    { id: "step", header: "Step", width: 120, render: (b) => stepLabel(b.step) },
    {
      id: "escalations",
      header: "Escalations",
      width: 110,
      sortValue: (b) => openCount(b.id),
      render: (b) => {
        const n = openCount(b.id);
        return n > 0 ? (
          <span className="bx-escalation-count" title="Open escalations">
            {n} open
          </span>
        ) : null;
      },
    },
    {
      id: "project",
      header: "Project",
      sortValue: (b) => projectName(b.projectId),
      render: (b) => projectName(b.projectId),
    },
    {
      id: "updated",
      header: "Updated",
      width: 110,
      sortValue: (b) => Date.parse(b.updatedAt),
      render: (b) => (
        <span className="bx-dim" title={b.updatedAt}>
          {relativeTime(b.updatedAt)}
        </span>
      ),
    },
  ];
}

const rowKey = (b: BuildSummary) => b.id;
const rowTitle = (b: BuildSummary) => `${b.slug}\n${b.id}${b.boxId ? `\nbox ${b.boxId}` : ""}`;

export function BuildsView(props: BuildsViewProps) {
  const { projects, builds, selectedId, onSelect, detail, escalations } = props;
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const columns = useMemo(() => {
    const names = new Map(projects.map((p) => [p.project.id, p.project.name]));
    return buildColumns(
      (id) => names.get(id) ?? id,
      (id) => escalations?.get(id)?.length ?? 0,
    );
  }, [projects, escalations]);
  const selected = useMemo(() => new Set(selectedId ? [selectedId] : []), [selectedId]);
  const current = selectedId ? builds.find((b) => b.id === selectedId) : undefined;
  return (
    <div className="bx-builds">
      {props.error ? (
        <div className="bx-dim" role="alert">
          Can't load builds: {props.error}
        </div>
      ) : null}
      <div className="bx-builds-list">
        <DataTable
          label="Builds"
          rows={builds}
          rowKey={rowKey}
          rowTitle={rowTitle}
          columns={columns}
          selected={selected}
          onSelectionChange={(s) => onSelect([...s][0] ?? null)}
          emptyText={BUILDS_EMPTY_TEXT}
          sort={sort}
          onSortChange={setSort}
        />
      </div>
      {current && detail ? <div className="bx-builds-detail">{detail(current)}</div> : null}
    </div>
  );
}
