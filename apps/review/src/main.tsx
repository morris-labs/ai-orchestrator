// Renderer entry. Electron's preload provides the token and the server URL;
// a plain browser on the server's origin uses the session cookie.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ApiClient } from "@agentbox/ui/core";
import { bridge } from "./lib/bridge.js";
import { AppStore, StoreProvider } from "./state/store.js";
import "./styles.css";

const b = bridge();
const store = new AppStore(new ApiClient({ baseUrl: b?.serverUrl ?? "", token: b?.token ?? null }));
store.start();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
