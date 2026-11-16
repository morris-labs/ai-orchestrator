import appPackage from "../package.json";
// The app shell: navigation, the status line, and the routed screens.
import { LOCAL_MACHINE_ID } from "@aio/contracts";
import { UpgradeStatus } from "@aio/ui";
import { Dashboard, dashboardCss, themeCss } from "@aio/ui/dashboard";
import { useEffect, useState } from "react";
import {
  FleetRuns,
  MachinePicker,
  machineName,
  useFleet,
  useFleetState,
} from "./components/machines.js";
import { bridge } from "./lib/bridge.js";
import { Findings } from "./screens/Findings.js";
import { Launcher } from "./screens/Launcher.js";
import { Policy } from "./screens/Policy.js";
import { RunList, RunView } from "./screens/RunView.js";
import { Settings } from "./screens/Settings.js";
import { isMulti } from "./state/fleet.js";
import {
  confirmLeave,
  href,
  linkedMachine,
  moveDeepLinkToHash,
  navigate,
  parseHash,
  useRoute,
  type Route,
  type RouteName,
} from "./state/router.js";
import { StoreProvider, useAppStore, useStore } from "./state/store.js";

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
  const fleet = useFleetState();
  return (
    <div className="screen wide">
      <h2>Infrastructure</h2>
      <FleetRuns />
      {isMulti(fleet) ? (
        <h3 className="machine-heading">On {machineName(fleet, fleet.selected)}</h3>
      ) : null}
      <Dashboard
        state={dashboard}
        usageInfo={usageInfo}
        connection={connection}
        onOpenRun={(id) => navigate(href(`/runs/${id}`))}
      />
    </div>
  );
}

/** The same screen without the params and query that name one machine's run, project, or box. */
function screenPath(route: Route): string {
  return route.name === "run" ? "/runs" : `/${route.name}`;
}

export function App({
  search = typeof location !== "undefined" ? location.search : "",
}: {
  search?: string;
}) {
  // The deep link in the page's query applies once: it moves into the hash
  // before the route is read, and later routes don't see it.
  const fleet = useFleet();
  useState(() => {
    moveDeepLinkToHash(search);
    // A link to a box on another machine opens that machine first.
    const machine = linkedMachine(parseHash(window.location.hash));
    if (fleet && machine) fleet.select(machine);
  });
  const { selected } = useFleetState();
  const root = useAppStore();
  // Each machine has its own store; a switch remounts the screens on it.
  const store = fleet ? fleet.storeFor(selected) : root;
  return (
    <StoreProvider key={selected} store={store}>
      <AppShell />
    </StoreProvider>
  );
}

function AppShell() {
  const route = useRoute();
  const connection = useStore((s) => s.connection);
  const storeError = useStore((s) => s.error);
  const waiting = useStore(
    (s) =>
      Object.values(s.dashboard.runs).filter((r) => r.run?.status === "waiting_decision").length,
  );

  const fleet = useFleet();
  // A link that the window gets while it's open, such as from the Boxes
  // app, can name another machine. Links without one, such as from a
  // notification of this server, show this machine.
  const linked = linkedMachine(route);
  useEffect(() => {
    if (fleet && linked) fleet.select(linked);
  }, [fleet, linked]);
  useEffect(
    () =>
      bridge()?.onNavigate?.((hash) => {
        const machine = linkedMachine(parseHash(hash)) ?? LOCAL_MACHINE_ID;
        // A switch remounts the screens before the route's own leave check
        // can run, so it asks first.
        if (fleet?.canSelect(machine) && machine !== fleet.getState().selected) {
          if (!confirmLeave()) return;
          fleet.select(machine);
        }
        navigate(hash);
      }),
    [fleet],
  );

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
      screen = <Policy projectId={route.query.get("project")} />;
      break;
    case "settings":
      screen = <Settings />;
      break;
    default:
      screen = (
        <Launcher
          prefill={{
            project: route.query.get("project"),
            box: route.query.get("box"),
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
          <div className="brand">AI Orchestrator Review</div>
          <MachinePicker
            onSwitch={() => {
              if (route.name === "run" || [...route.query].length > 0) {
                navigate(href(screenPath(route)));
              }
            }}
          />
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
        <main className="main">
          <UpgradeStatus
            runningVersion={bridge()?.appVersion ?? appPackage.version}
            onRelaunch={() => {
              const b = bridge();
              if (b?.relaunch) b.relaunch();
              else window.location.reload();
            }}
          />
          {screen}
        </main>
      </div>
    </>
  );
}
