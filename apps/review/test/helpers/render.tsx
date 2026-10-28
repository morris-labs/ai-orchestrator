// Renders a screen with an app store over the mock server.
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createApiClient } from "../../src/lib/api.js";
import { AppStore, StoreContext } from "../../src/state/store.js";
import { createMockServer, type Handler, type MockServer } from "./mockServer.js";
import { MockSocket } from "./stream.js";

export function renderWithStore(ui: ReactElement, handlers: Record<string, Handler> = {}) {
  const server: MockServer = createMockServer(handlers);
  const api = createApiClient({ fetch: server.fetch, token: "t" });
  const store = new AppStore(api, (url) => new MockSocket(url));
  const result = render(<StoreContext.Provider value={store}>{ui}</StoreContext.Provider>);
  return { ...result, server, store };
}
