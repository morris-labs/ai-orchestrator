// Renderer entry. Electron's preload provides the server URL and, once, the
// token; a plain browser on the server's origin uses the session cookie. The
// page's WebSockets always use the cookie, since a browser can't set their
// headers, so a token is traded for the cookie before the store opens them,
// and the client then forgets it.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ApiClient, createMachineClient } from "@aio/ui/core";
import { FleetProvider } from "./components/machines.js";
import { bridge } from "./lib/bridge.js";
import { MachineFleet } from "./state/fleet.js";
import { AppStore, StoreProvider } from "./state/store.js";
import "./styles.css";

const b = bridge();
const client = new ApiClient({ baseUrl: b?.serverUrl ?? "", token: b?.takeToken() ?? null });
const store = new AppStore(client);
// Another machine's client authenticates with the session cookie, which
// `startSession()` sets, and reaches the machine through this server.
const fleet = new MachineFleet(store, (machineId) =>
  createMachineClient({ baseUrl: b?.serverUrl ?? "" }, machineId),
);
void client.startSession().finally(() => {
  store.start();
  fleet.start();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider store={store}>
      <FleetProvider fleet={fleet}>
        <App />
      </FleetProvider>
    </StoreProvider>
  </StrictMode>,
);
