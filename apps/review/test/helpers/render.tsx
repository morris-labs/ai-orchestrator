// Renders a screen with an app store over the shared fake server from
// `@agentbox/ui/testing`. Handlers given here replace the fake's defaults
// for their routes; the fake checks every request and answer against the
// contracts.
import { render } from "@testing-library/react";
import { ApiClient, type HttpRouteKey } from "@agentbox/ui/core";
import { FakeServer, type FakeHandler, type FakeRequest } from "@agentbox/ui/testing";
import type { ReactElement } from "react";
import { AppStore, StoreProvider } from "../../src/state/store.js";

export type Handler = (req: FakeRequest) => unknown;

export function renderWithStore(ui: ReactElement, handlers: Record<string, Handler> = {}) {
  const server = new FakeServer();
  for (const [key, handler] of Object.entries(handlers)) {
    server.on(key as HttpRouteKey, handler as FakeHandler);
  }
  const api = new ApiClient({ fetch: server.fetch, token: "t", WebSocket: server.WebSocket });
  const store = new AppStore(api);
  const result = render(<StoreProvider store={store}>{ui}</StoreProvider>);
  return { ...result, server, store };
}
