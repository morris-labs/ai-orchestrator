// The providers around the app: the API client, the event stream, message
// boxes, and toasts.
import {
  ApiClientProvider,
  EventHub,
  EventHubProvider,
  EventsConnection,
  MessageBoxProvider,
  ToastProvider,
  type ApiClient,
} from "@agentbox/ui";
import { useEffect, useMemo, type ReactNode } from "react";

/** Event types the boxes app uses. */
export const BOX_EVENT_TYPES = [
  "box.changed",
  "container.changed",
  "container.stats",
  "ports.changed",
  "terminal.ended",
  "settings.changed",
  "notification",
] as const;

export function Root({ client, children }: { client: ApiClient; children: ReactNode }) {
  const hub = useMemo(() => new EventHub(), []);
  useEffect(() => {
    const conn = new EventsConnection({
      client,
      types: BOX_EVENT_TYPES,
      onEvent: (e) => hub.emit(e),
      onResync: () => hub.resync(),
      onStatus: (s) => hub.setStatus(s),
      onInvalidFrame: (_raw, error) =>
        console.warn(`Dropped an event frame that breaks the contract: ${error}`),
    });
    conn.start();
    return () => conn.stop();
  }, [client, hub]);
  return (
    <ApiClientProvider client={client}>
      <EventHubProvider hub={hub}>
        <ToastProvider>
          <MessageBoxProvider>{children}</MessageBoxProvider>
        </ToastProvider>
      </EventHubProvider>
    </ApiClientProvider>
  );
}
