// The GUI apps section of the Machines page: on the hub, it issues a one-time
// code for an app on another PC, lists the enrolled apps, and revokes one. An app
// on another PC can't manage enrollment, so the server refuses the list and this
// section doesn't show.
import type { EnrollmentCode, GuiClient } from "@aio/contracts";
import {
  Button,
  DataTable,
  Dialog,
  errorMessage,
  useMessageBox,
  useToast,
  type ApiClient,
  type Column,
  type SortState,
} from "@aio/ui";
import { useCallback, useEffect, useState } from "react";

export function GuiClientsSection({ client }: { client: ApiClient }) {
  const { confirm, inform } = useMessageBox();
  const toast = useToast();
  const [clients, setClients] = useState<GuiClient[] | null>(null);
  const [code, setCode] = useState<EnrollmentCode | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>({ column: "name", direction: "asc" });

  const reload = useCallback(async () => {
    try {
      setClients((await client.call("gui.list")).clients);
    } catch {
      setClients(null);
    }
  }, [client]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (clients === null) return null;

  const issue = async () => {
    try {
      setCode(await client.call("gui.enroll"));
      await reload();
    } catch (err) {
      void inform("Add GUI App", errorMessage(err));
    }
  };
  const revoke = async (app: GuiClient) => {
    const yes = await confirm(
      "Revoke GUI App",
      `Revoke "${app.name}"?`,
      "The app loses access at its next request, and its open terminals close. To use it again, enroll it with a new code.",
      true,
    );
    if (!yes) return;
    try {
      await client.call("gui.revoke", { params: { id: app.id } });
      toast(`Revoked ${app.name}.`);
      await reload();
    } catch (err) {
      void inform("Revoke GUI App", errorMessage(err));
    }
  };
  const copy = (text: string, what: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast(`The ${what} is on the clipboard.`))
      .catch(() => undefined);
  };

  const columns: Column<GuiClient>[] = [
    { id: "name", header: "Name", width: 170, sortValue: (a) => a.name, render: (a) => a.name },
    {
      id: "status",
      header: "Status",
      width: 90,
      sortValue: (a) => a.status,
      render: (a) => (a.status === "active" ? "Active" : "Revoked"),
    },
    {
      id: "lastSeen",
      header: "Last seen",
      width: 200,
      sortValue: (a) => a.lastSeen ?? "",
      render: (a) => a.lastSeen ?? "Never",
    },
    {
      id: "action",
      header: "",
      width: 90,
      render: (a) =>
        a.status === "active" ? (
          <button type="button" onClick={() => void revoke(a)}>
            Revoke
          </button>
        ) : null,
    },
  ];

  return (
    <section aria-label="GUI apps">
      <div className="bx-toolbar">
        <strong>GUI apps on other PCs</strong>
        <button type="button" onClick={() => void issue()}>
          Add GUI App...
        </button>
      </div>
      {clients.length === 0 ? (
        <p className="bx-dim">
          No GUI apps yet. Use Add GUI App to control this hub from another PC.
        </p>
      ) : (
        <DataTable
          label="Enrolled GUI apps"
          selected={selected}
          onSelectionChange={setSelected}
          columns={columns}
          rows={clients}
          rowKey={(app) => app.id}
          sort={sort}
          onSortChange={setSort}
        />
      )}
      {code ? (
        <Dialog
          title="Add GUI App"
          onClose={() => setCode(null)}
          buttons={
            <>
              <Button onClick={() => copy(code.hubUrl, "hub URL")}>Copy Hub URL</Button>
              <Button onClick={() => copy(code.code, "code")}>Copy Code</Button>
              <Button primary onClick={() => setCode(null)}>
                Close
              </Button>
            </>
          }
        >
          <p>
            In the app on the other PC, open the connection window, and enter this hub URL and code.
            The code works once, until {code.expiresAt}.
          </p>
          <p>
            <code aria-label="Hub URL">{code.hubUrl}</code>
          </p>
          <p>
            <code aria-label="GUI enrollment code">{code.code}</code>
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}
