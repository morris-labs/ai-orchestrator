// The app shell: navigation, the status line, and the routed screens.
import { Dashboard, dashboardCss, themeCss } from "@agentbox/ui/dashboard";
import { useEffect } from "react";
import { bridge } from "./lib/api.js";
import { Findings } from "./screens/Findings.js";
import { Launcher } from "./screens/Launcher.js";
import { Policy } from "./screens/Policy.js";
import { RunList, RunView } from "./screens/RunView.js";
import { Settings } from "./screens/Settings.js";
import { deepLink, href, navigate, useRoute, type RouteName } from "./state/router.js";
import { useStore } from "./state/store.js";

const NAV: Array<{ name: RouteName; path: string; label: string }> = [
  { name: "launch", path: "/launch", label: "Start run" },
  { name: "runs", path: "/runs", label: "Runs" },
  { name: "findings", path: "/findings", label: "Findings" },
  { name: "dashboard", path: "/dashboard", label: "Dashboard" },
  { name: "policy", path: "/policy", label: "Policy" },
  { name: "settings", path: "/settings", label: "Settings" },
];

function DashboardScreen() {
  const dashboard = useStore((s) => s.dashboard);
  const usageInfo = useStore((s) => s.usageInfo);
  const connection = useStore((s) => s.connection);
  return (
    <div className="screen wide">
      <h2>Infrastructure</h2>
      <Dashboard
        state={dashboard}
        usageInfo={usageInfo}
        connection={connection}
        onOpenRun={(id) => navigate(href(`/runs/${id}`))}
      />
    </div>
  );
}

export function App({
  search = typeof location !== "undefined" ? location.search : "",
}: {
  search?: string;
}) {
  const route = useRoute();
  const connection = useStore((s) => s.connection);
  const storeError = useStore((s) => s.error);
  const waiting = useStore(
    (s) =>
      Object.values(s.dashboard.runs).filter((r) => r.run?.status === "waiting_decision").length,
  );
  const prefill = deepLink(search);

  useEffect(() => bridge()?.onNavigate?.((hash) => navigate(hash)), []);

  const active = route.name === "run" ? "runs" : route.name;
  let screen;
  switch (route.name) {
    case "run":
      screen = <RunView key={route.params.runId} runId={route.params.runId!} />;
      break;
    case "runs":
      screen = <RunList />;
      break;
    case "findings":
      screen = <Findings runId={route.query.get("run")} findingId={route.query.get("finding")} />;
      break;
    case "dashboard":
      screen = <DashboardScreen />;
      break;
    case "policy":
      screen = <Policy projectId={route.query.get("project") ?? prefill.project} />;
      break;
    case "settings":
      screen = <Settings />;
      break;
    default:
      screen = (
        <Launcher
          prefill={{
            project: route.query.get("project") ?? prefill.project,
            box: route.query.get("box") ?? prefill.box,
          }}
        />
      );
  }

  return (
    <>
      <style>{themeCss}</style>
      <style>{dashboardCss}</style>
      <div className="app">
        <nav className="nav" aria-label="Main">
          <div className="brand">Agent Box Review</div>
          <ul>
            {NAV.map((n) => (
              <li key={n.name}>
                <a href={href(n.path)} aria-current={active === n.name ? "page" : undefined}>
                  {n.label}
                  {n.name === "runs" && waiting > 0 ? (
                    <span className="badge" aria-label={`${waiting} need a decision`}>
                      {waiting}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
          <div className="nav-foot">
            <span
              className={`ab-status ab-tone-${connection === "open" ? "good" : connection === "connecting" ? "warning" : "critical"}`}
            >
              {connection === "open"
                ? "● Live"
                : connection === "connecting"
                  ? "◐ Connecting"
                  : "✕ Offline"}
            </span>
            {storeError ? (
              <p className="muted small" title={storeError}>
                {storeError}
              </p>
            ) : null}
          </div>
        </nav>
        <main className="main">{screen}</main>
      </div>
    </>
  );
}
