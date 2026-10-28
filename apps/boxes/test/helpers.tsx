// Renders a tree against a fake server, with every provider the app uses.
import { ApiClient } from "@agentbox/ui";
import type { FakeServer } from "@agentbox/ui/testing";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Root } from "../src/app/Root";

export function renderWithServer(ui: ReactNode, server: FakeServer) {
  const client = new ApiClient({
    baseUrl: "http://127.0.0.1:20400",
    token: "t",
    fetch: server.fetch,
    WebSocket: server.WebSocket,
  });
  return { client, ...render(<Root client={client}>{ui}</Root>) };
}
