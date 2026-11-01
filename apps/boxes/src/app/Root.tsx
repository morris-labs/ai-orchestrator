// The providers around the app: message boxes, toasts, and this server's
// API client and event stream. Message boxes and toasts sit outside the
// machine scopes, so a message from any machine's view shows in front.
import { MessageBoxProvider, ToastProvider, type ApiClient } from "@aio/ui";
import type { ReactNode } from "react";
import { MachineScope } from "./machine";

export function Root({ client, children }: { client: ApiClient; children: ReactNode }) {
  return (
    <ToastProvider>
      <MessageBoxProvider>
        <MachineScope client={client}>{children}</MachineScope>
      </MessageBoxProvider>
    </ToastProvider>
  );
}
