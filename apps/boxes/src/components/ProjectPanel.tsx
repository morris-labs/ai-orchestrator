// The project list left of the box table: "All projects (N)", then one row
// per project with its running and total counts, sorted by name.
import type { ProjectSummary } from "@agentbox/contracts";
import { StatusDot, useContextMenu, type MenuEntry } from "@agentbox/ui";

export interface ProjectPanelProps {
  projects: ProjectSummary[];
  totalBoxes: number;
  selected: string | null;
  onSelect: (projectId: string | null) => void;
  menuFor: (project: ProjectSummary) => MenuEntry[];
}

export function sortedProjects(projects: readonly ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) =>
    a.project.name.localeCompare(b.project.name, undefined, { sensitivity: "base" }),
  );
}

export function ProjectPanel({
  projects,
  totalBoxes,
  selected,
  onSelect,
  menuFor,
}: ProjectPanelProps) {
  const menu = useContextMenu();
  const rows = sortedProjects(projects);
  return (
    <div className="bx-projects" role="listbox" aria-label="Projects">
      <div
        role="option"
        aria-selected={selected === null}
        className={`bx-project${selected === null ? " bx-active" : ""}`}
        onClick={() => onSelect(null)}
      >
        All projects ({totalBoxes})
      </div>
      {rows.map((p) => (
        <div
          key={p.project.id}
          role="option"
          aria-selected={selected === p.project.id}
          className={`bx-project${selected === p.project.id ? " bx-active" : ""}`}
          title={p.project.root}
          onClick={() => onSelect(p.project.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onSelect(p.project.id);
            menu.open(e.clientX, e.clientY, menuFor(p));
          }}
        >
          <StatusDot state={p.running > 0 ? "running" : "known"} />
          <span className="bx-project-name">{p.project.name}</span>
          <span className="bx-dim">
            ({p.running}/{p.total})
          </span>
        </div>
      ))}
      {menu.element}
    </div>
  );
}
