// Entry point of the boxes renderer. In Electron the preload bridge gives
// the server URL and the token; in a browser the page's own origin serves
// the API, and a `#token=...` fragment, when present, is traded for the
// session cookie and removed from the address bar.
import "@agentbox/ui/theme.css";
import "./app.css";
import { ApiClient } from "@agentbox/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { Root } from "./app/Root";
import { bridge } from "./bridge";

async function makeClient(): Promise<ApiClient> {
  const b = bridge();
  if (b) return new ApiClient({ baseUrl: b.serverUrl, token: b.token });
  const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (m?.[1]) {
    const token = decodeURIComponent(m[1]);
    history.replaceState(null, "", location.pathname + location.search);
    await new ApiClient({ token }).call("auth.session", {}).catch(() => undefined);
  }
  return new ApiClient();
}

void makeClient().then((client) => {
  const el = document.getElementById("root");
  if (!el) return;
  createRoot(el).render(
    <StrictMode>
      <Root client={client}>
        <App />
      </Root>
    </StrictMode>,
  );
});
