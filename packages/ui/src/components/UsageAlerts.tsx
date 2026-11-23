// Usage watcher alerts, shown in both desktop apps until the owner dismisses
// them. The server raises them; nothing pauses on its own.
import type { Notification } from "@aio/contracts";
import { useCallback, useEffect, useState } from "react";
import { useApiClient } from "../api/react";
import { useEvent, useResync, useStreamStatus } from "../events/react";
import { Button } from "./Dialog";

const isUsageAlert = (n: Pick<Notification, "kind" | "read">) =>
  n.kind === "usage_alert" && !n.read;

/** The unread usage alerts as a bar under the app's header, newest first. */
export function UsageAlerts() {
  const client = useApiClient();
  const connection = useStreamStatus();
  const [alerts, setAlerts] = useState<Notification[]>([]);

  const reload = useCallback(() => {
    void client
      .call("notifications.list", { query: { unread: true } })
      .then((r) => setAlerts(r.notifications.filter(isUsageAlert)))
      .catch(() => undefined);
  }, [client]);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (connection === "open") reload();
  }, [reload, connection]);
  useResync(reload);

  useEvent("notification", (event) => {
    if (!isUsageAlert(event)) return;
    const { notificationId, kind, title, body, runId, boxId, buildId, severity, read } = event;
    const alert: Notification = {
      notificationId,
      kind,
      title,
      body,
      runId,
      boxId,
      ...(buildId === undefined ? {} : { buildId }),
      severity,
      read,
    };
    setAlerts((all) => [alert, ...all.filter((a) => a.notificationId !== notificationId)]);
  });

  const dismiss = (id: string) => {
    setAlerts((all) => all.filter((a) => a.notificationId !== id));
    void client
      .call("notifications.read", { params: { notificationId: id } })
      .catch(() => undefined);
  };

  if (alerts.length === 0) return null;
  return (
    <section aria-label="Usage alerts">
      {alerts.map((a) => (
        <div key={a.notificationId} role="alert" className="ab-update-bar">
          <span>
            <strong>{a.title}</strong> {a.body}
          </span>
          <Button aria-label={`Dismiss ${a.title}`} onClick={() => dismiss(a.notificationId)}>
            Dismiss
          </Button>
        </div>
      ))}
    </section>
  );
}
