// Renderer entry. Electron's preload provides the server URL and, once, the
// token; a plain browser on the server's origin uses the session cookie. The
// page's WebSockets always use the cookie, since a browser can't set their
// headers, so a token is traded for the cookie before the store opens them,
// and the client then forgets it.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ApiClient } from "@agentbox/ui/core";
import { bridge } from "./lib/bridge.js";
import { AppStore, StoreProvider } from "./state/store.js";
import "./styles.css";

const b = bridge();
const client = new ApiClient({ baseUrl: b?.serverUrl ?? "", token: b?.takeToken() ?? null });
const store = new AppStore(client);
void client.startSession().finally(() => store.start());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
