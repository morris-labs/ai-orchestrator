// Renderer entry. Electron's preload provides the token and the server URL;
// a plain browser on the server's origin uses the session cookie.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { bridge, createApiClient } from "./lib/api.js";
import { AppStore, StoreContext } from "./state/store.js";
import "./styles.css";

const b = bridge();
const store = new AppStore(
  createApiClient({ baseUrl: b?.serverUrl ?? "", token: b?.token ?? null }),
);
store.start();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreContext.Provider value={store}>
      <App />
    </StoreContext.Provider>
  </StrictMode>,
);
