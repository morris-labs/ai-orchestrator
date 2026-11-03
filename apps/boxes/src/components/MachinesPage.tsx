// The Machines page: the controller view of a multi-machine install. It
// lists every machine the hub knows with its health (status, versions,
// image, and free disk), enrolls a new one with a one-time code, and
// revokes one.
import type { EnrollmentCode, Machine } from "@aio/contracts";
import {
  Button,
  DataTable,
  Dialog,
  StatusDot,
  errorMessage,
  useContextMenu,
  useMessageBox,
  useToast,
  type ApiClient,
  type Column,
  type SortState,
} from "@aio/ui";
import { useMemo, useState } from "react";
import { bridge } from "../bridge";
import { GuiClientsSection } from "./GuiClientsSection";
import {
  createEnrollmentCode,
  diskText,
  hasTab,
  imageText,
  imageTitle,
  joinCommand,
  lastSeenText,
  machineDot,
  machinePlatformLabel,
  machineRoleLabel,
  machineStatusLabel,
  relativeTime,
  revokeMachine,
  skewNotes,
} from "../logic/machines";

export interface MachinesPageProps {
  /** The client of this server, which hosts the hub's machine routes. */
  client: ApiClient;
  machines: Machine[];
  /** Why the last machine list reload failed, or `null`. */
  error: string | null;
  reload: () => Promise<void>;
  /** Shows a machine's boxes. */
  onOpen: (machineId: string) => void;
}

export function MachinesPage(props: MachinesPageProps) {
  const { confirm, inform } = useMessageBox();
  const toast = useToast();
  const menu = useContextMenu();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });
  const [code, setCode] = useState<EnrollmentCode | null>(null);
  const local = props.machines.find((m) => m.isLocal);
  const single = props.machines.find((m) => selected.has(m.id)) ?? null;

  const columns = useMemo<Column<Machine>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        width: 170,
        // This PC stays on top when sorting by name.
        sortValue: (m) => `${m.isLocal ? 0 : 1}${m.name.toLowerCase()}`,
        render: (m) => (
          <span className="bx-status">
            <StatusDot state={machineDot(m)} title={machineStatusLabel[m.status]} />
            {m.name}
            {m.isLocal && (
              <span className="bx-badge">{bridge()?.remoteHub ? "hub" : "this PC"}</span>
            )}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 90,
        sortValue: (m) => m.status,
        render: (m) => machineStatusLabel[m.status],
      },
      {
        id: "role",
        header: "Role",
        width: 110,
        sortValue: (m) => m.role,
        render: (m) => machineRoleLabel[m.role],
      },
      {
        id: "platform",
        header: "Platform",
        width: 80,
        sortValue: (m) => m.platform ?? "",
        render: (m) => (m.platform ? machinePlatformLabel[m.platform] : "-"),
      },
      {
        id: "version",
        header: "Server version",
        width: 110,
        sortValue: (m) => m.serverVersion ?? "",
        render: (m) => m.serverVersion ?? "-",
      },
      {
        id: "engine",
        header: "Engine version",
        width: 110,
        sortValue: (m) => m.health?.engineVersion ?? "",
        render: (m) => m.health?.engineVersion ?? "-",
      },
      {
        id: "image",
        header: "Image",
        width: 120,
        sortValue: (m) => m.health?.image ?? "",
        render: (m) => <span title={imageTitle(m)}>{imageText(m)}</span>,
      },
      {
        id: "disk",
        header: "Disk free",
        width: 140,
        sortValue: (m) => m.health?.diskFreeBytes ?? -1,
        render: (m) => diskText(m),
      },
      {
        id: "protocol",
        header: "Protocol",
        width: 70,
        sortValue: (m) => m.protocol ?? -1,
        render: (m) => (m.protocol === null ? "-" : String(m.protocol)),
      },
      {
        id: "capabilities",
        header: "Capabilities",
        render: (m) => (
          <span className="bx-dim" title={m.capabilities.join("\n")}>
            {m.capabilities.length > 0 ? m.capabilities.join(", ") : "-"}
          </span>
        ),
      },
      {
        id: "lastSeen",
        header: "Last seen",
        width: 120,
        sortValue: (m) => m.lastSeen ?? "",
        render: (m) =>
          m.isLocal ? "now" : <span title={lastSeenText(m)}>{relativeTime(m.lastSeen)}</span>,
      },
      {
        id: "notes",
        header: "Notes",
        render: (m) => {
          const notes = skewNotes(m, local);
          return notes.length > 0 ? (
            <span className="bx-machine-skew" title={notes.join("\n")}>
              {notes.join(" ")}
            </span>
          ) : (
            ""
          );
        },
      },
    ],
    [local],
  );

  const addMachine = async () => {
    try {
      setCode(await createEnrollmentCode(props.client));
    } catch (err) {
      void inform("Add Machine", errorMessage(err));
    }
  };

  const revoke = async (m: Machine) => {
    if (m.isLocal || m.status === "revoked") return;
    const ok = await confirm(
      "Revoke Machine",
      `Revoke "${m.name}"?`,
      "The hub stops routing to it and refuses its certificate. Its boxes keep running on that PC, but this window can't reach them. To add it again, enroll it with a new code.",
      true,
    );
    if (!ok) return;
    try {
      await revokeMachine(props.client, m.id);
      toast(`Revoked ${m.name}.`, { kind: "success" });
    } catch (err) {
      void inform("Revoke Machine", errorMessage(err));
    }
    await props.reload();
  };

  const canOpen = (m: Machine | null) => m !== null && (m.isLocal || hasTab(m));
  const canRevoke = (m: Machine | null) => m !== null && !m.isLocal && m.status !== "revoked";

  const skewed = props.machines.filter((m) => skewNotes(m, local).length > 0);

  return (
    <div className="bx-machines-page">
      <div className="ab-toolbar" role="toolbar" aria-label="Machine actions">
        <button type="button" className="ab-tool" onClick={() => void addMachine()}>
          Add Machine...
        </button>
        <span className="ab-separator" />
        <button
          type="button"
          className="ab-tool"
          disabled={!canOpen(single)}
          onClick={() => single && props.onOpen(single.id)}
        >
          Show Boxes
        </button>
        <button
          type="button"
          className="ab-tool"
          disabled={!canRevoke(single)}
          onClick={() => single && void revoke(single)}
        >
          Revoke...
        </button>
        <span className="ab-spacer" />
        <button type="button" className="ab-tool" onClick={() => void props.reload()}>
          Refresh Now
        </button>
      </div>
      {props.error && (
        <div role="alert" className="ab-error-text bx-machines-note">
          The machine list didn't reload: {props.error}
        </div>
      )}
      {skewed.length > 0 && (
        <div role="note" className="bx-machines-note bx-machine-skew">
          {skewed.length === 1
            ? `${skewed[0]?.name} runs a different server version from this PC. See Notes.`
            : `${skewed.length} machines run a different server version from this PC. See Notes.`}
        </div>
      )}
      <DataTable
        label="Machines"
        rows={props.machines}
        rowKey={(m) => m.id}
        columns={columns}
        selected={selected}
        onSelectionChange={setSelected}
        onActivate={(m) => canOpen(m) && props.onOpen(m.id)}
        onContextMenu={(m, x, y) =>
          m &&
          menu.open(x, y, [
            { label: "Show Boxes", enabled: canOpen(m), run: () => props.onOpen(m.id) },
            { type: "separator" },
            { label: "Revoke...", enabled: canRevoke(m), run: () => void revoke(m) },
          ])
        }
        emptyText="No machines yet. Use Add Machine to enroll another PC."
        sort={sort}
        onSortChange={setSort}
      />
      <GuiClientsSection client={props.client} />
      {menu.element}
      {code && <EnrollmentDialog code={code} onClose={() => setCode(null)} />}
    </div>
  );
}

/** Shows an enrollment code and the command that uses it. */
export function EnrollmentDialog({ code, onClose }: { code: EnrollmentCode; onClose: () => void }) {
  const toast = useToast();
  const command = joinCommand(code);
  const expires = new Date(code.expiresAt);
  const copy = (text: string, what: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast(`The ${what} is on the clipboard.`))
      .catch(() => undefined);
  };
  return (
    <Dialog
      title="Add Machine"
      width="min(620px, 94vw)"
      onClose={onClose}
      buttons={
        <>
          <Button onClick={() => copy(command, "command")}>Copy Command</Button>
          <Button onClick={() => copy(code.code, "code")}>Copy Code</Button>
          <Button primary onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <p>
        On the PC to add, install AI Orchestrator, and then run this command in a terminal. Enter
        the code when the command asks for it. The code works once.
      </p>
      <input
        className="ab-input bx-machine-command"
        aria-label="Enrollment command"
        readOnly
        value={command}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="bx-row bx-machine-code">
        <span className="bx-dim">Code</span>
        <code aria-label="Enrollment code">{code.code}</code>
      </div>
      <p className="bx-dim bx-small">
        The code expires{" "}
        {Number.isNaN(expires.getTime()) ? code.expiresAt : `at ${expires.toLocaleString()}`}. The
        new machine appears in this list once it connects.
      </p>
    </Dialog>
  );
}
