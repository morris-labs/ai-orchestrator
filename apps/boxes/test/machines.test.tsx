// The machine tabs and the Machines page, against one fake server per
// machine behind a fake hub that forwards /api/v1/machines/ID/proxy/REST
// to machine ID's /api/v1/REST.
import type { EnrollmentCode, Machine } from "@aio/contracts";
import { ApiClient, createMachineClient } from "@aio/ui";
import { FakeServer, makeBoxView, makeEvent } from "@aio/ui/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Root } from "../src/app/Root";
import { Shell } from "../src/app/Shell";
import { lastSeenText, relativeTime, skewNotes, sortMachines } from "../src/logic/machines";

const T_SEEN = "2026-10-31T08:00:00.000Z";

function machine(over: Partial<Machine> & Pick<Machine, "id" | "name">): Machine {
  return {
    role: "node",
    status: "online",
    isLocal: false,
    serverVersion: "1.1.0",
    protocol: 1,
    capabilities: ["boxes", "terminals"],
    lastSeen: T_SEEN,
    platform: "linux",
    ...over,
  };
}

const LOCAL = machine({
  id: "local",
  name: "main-pc",
  role: "both",
  isLocal: true,
  lastSeen: null,
});

const PROXY = /^\/api\/v1\/machines\/([^/]+)\/proxy(\/.*)?$/;

interface Hub {
  machines: Machine[] | "unsupported";
  /** Every request URL path the app sent, before forwarding. */
  paths: string[];
  /** Every WebSocket URL path the app opened, before forwarding. */
  socketPaths: string[];
  revoked: string[];
  codes: number;
}

/** Renders the shell against a fake hub with `servers` behind it; `local` is this PC. */
function renderHub(opts: {
  local: FakeServer;
  servers?: Record<string, FakeServer>;
  machines: Machine[] | "unsupported";
}) {
  const hub: Hub = { machines: opts.machines, paths: [], socketPaths: [], revoked: [], codes: 0 };
  const servers = opts.servers ?? {};
  const json = (status: number, body: unknown) =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const route = (url: URL): { server: FakeServer; url: string } | null => {
    const m = PROXY.exec(url.pathname);
    if (!m) return { server: opts.local, url: url.href };
    const id = decodeURIComponent(m[1] ?? "");
    const server = id === "local" ? opts.local : servers[id];
    if (!server) return null;
    return { server, url: `${url.origin}/api/v1${m[2] ?? ""}${url.search}` };
  };
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    hub.paths.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/v1/machines" && method === "GET") {
      if (hub.machines === "unsupported")
        return json(404, { error: { code: "not_found", message: "No route." } });
      return json(200, { machines: hub.machines });
    }
    if (url.pathname === "/api/v1/machines/enrollment-codes" && method === "POST") {
      hub.codes += 1;
      const code: EnrollmentCode = {
        code: "ABCD-1234",
        expiresAt: "2026-11-01T12:10:00.000Z",
        hubUrl: "https://hub.example.com:21400",
      };
      return json(201, code);
    }
    const del = /^\/api\/v1\/machines\/([^/]+)$/.exec(url.pathname);
    if (del && method === "DELETE") {
      const id = decodeURIComponent(del[1] ?? "");
      hub.revoked.push(id);
      if (Array.isArray(hub.machines))
        hub.machines = hub.machines.map((m) => (m.id === id ? { ...m, status: "revoked" } : m));
      return new Response(null, { status: 204 });
    }
    const target = route(url);
    if (!target)
      return json(503, {
        error: { code: "machine_offline", message: "The machine is not connected." },
      });
    return target.server.fetch(target.url, init);
  };
  const WebSocketCtor = class {
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      const u = new URL(url);
      hub.socketPaths.push(u.pathname);
      const target = route(u);
      const server = target?.server ?? opts.local;
      return new server.WebSocket(target?.url ?? url, options);
    }
  };
  const options = {
    baseUrl: "http://127.0.0.1:21400",
    fetch,
    WebSocket: WebSocketCtor as never,
  };
  const client = new ApiClient(options);
  const utils = render(
    <Root client={client}>
      <Shell pollMs={60_000} machineClient={(id) => createMachineClient(options, id)} />
    </Root>,
  );
  return { hub, client, ...utils };
}

function siteServer() {
  return new FakeServer({
    boxes: [
      makeBoxView({
        box: { id: "aio-agent-site", targetDir: "/w/site", conversationName: "Site work" },
        status: "running",
      }),
    ],
  });
}

function nodeServer() {
  return new FakeServer({
    boxes: [
      makeBoxView({
        box: { id: "aio-agent-site", targetDir: "/srv/site", conversationName: "Node site" },
        status: "running",
      }),
      makeBoxView({
        box: { id: "aio-agent-batch", targetDir: "/srv/batch", conversationName: "Batch" },
        status: "stopped",
      }),
    ],
  });
}

const rowOf = (name: string) => screen.getByRole("cell", { name }).closest("tr") as HTMLElement;
/** The Machines page row whose first cell reads `name`. */
const machineRow = (name: string) => {
  const table = screen.getByRole("table", { name: "Machines" });
  const row = within(table)
    .getAllByRole("row")
    .find((r) => r.querySelector("td")?.textContent?.startsWith(name));
  if (!row) throw new Error(`No machine row ${name}.`);
  return row;
};
const machineTabs = () => screen.getByRole("tablist", { name: "Machines" });

afterEach(() => {
  delete window.aio;
});

describe("machine tabs", () => {
  it("shows no tab strip when the hub knows only this PC", async () => {
    const { hub } = renderHub({ local: siteServer(), machines: [LOCAL] });
    await screen.findByRole("cell", { name: "Site work" });
    await waitFor(() => expect(hub.paths).toContain("GET /api/v1/machines"));
    expect(screen.queryByRole("tablist", { name: "Machines" })).toBeNull();
    // The Machines page stays reachable, to enroll the first machine.
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "File" }));
    expect(await screen.findByRole("menuitem", { name: /^Machines\.\.\./ })).toBeInTheDocument();
  });

  it("looks as before on a server without machine routes", async () => {
    const { hub } = renderHub({ local: siteServer(), machines: "unsupported" });
    await screen.findByRole("cell", { name: "Site work" });
    await waitFor(() => expect(hub.paths).toContain("GET /api/v1/machines"));
    expect(screen.queryByRole("tablist", { name: "Machines" })).toBeNull();
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "File" }));
    await screen.findByRole("menuitem", { name: /^Global Mounts/ });
    expect(screen.queryByRole("menuitem", { name: /^Machines\.\.\./ })).toBeNull();
    // Every request went to this server's own API.
    expect(hub.paths.filter((p) => p.includes("/proxy"))).toEqual([]);
  });

  it("lists this PC first, then each machine, then the Machines page", async () => {
    renderHub({
      local: siteServer(),
      servers: { "node-b": nodeServer() },
      machines: [
        machine({ id: "node-z", name: "zeta", status: "offline" }),
        machine({ id: "node-b", name: "node-b" }),
        LOCAL,
        machine({ id: "node-e", name: "enrolling-pc", status: "enrolling" }),
      ],
    });
    const tabs = within(await screen.findByRole("tablist", { name: "Machines" })).getAllByRole(
      "tab",
    );
    expect(tabs.map((t) => t.textContent)).toEqual([
      "main-pc (this PC)",
      "node-b",
      "zeta",
      "Machines",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("shows a machine's boxes through its proxy route and keeps each view apart", async () => {
    const user = userEvent.setup();
    const local = siteServer();
    const node = nodeServer();
    const { hub } = renderHub({
      local,
      servers: { "node-b": node },
      machines: [LOCAL, machine({ id: "node-b", name: "node-b" })],
    });
    await screen.findByRole("cell", { name: "Site work" });
    await user.click(within(machineTabs()).getByRole("tab", { name: "node-b" }));
    await screen.findByRole("cell", { name: "Node site" });
    // This PC's view is hidden, not gone.
    expect(screen.queryByRole("cell", { name: "Site work" })).toBeNull();
    expect(hub.paths).toContain("GET /api/v1/machines/node-b/proxy/boxes");
    expect(node.callsTo("boxes.list").length).toBeGreaterThan(0);
    await waitFor(() => expect(hub.socketPaths).toContain("/api/v1/machines/node-b/proxy/events"));

    // Start a stopped box: the call reaches node-b's server only.
    fireEvent.mouseDown(rowOf("Batch"), { button: 0 });
    const toolbar = screen.getByRole("toolbar", { name: "Box actions" });
    await user.click(within(toolbar).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(node.callsTo("boxes.start")).toHaveLength(1));
    expect(local.callsTo("boxes.start")).toHaveLength(0);
    expect(hub.paths).toContain("POST /api/v1/machines/node-b/proxy/boxes/aio-agent-batch/start");

    // The terminal tab names the machine, and attaches through the proxy.
    const terminals = await screen.findByRole("tablist", { name: "Terminals" });
    expect(within(terminals).getAllByRole("tab")[0]).toHaveTextContent("node-b / Batch");
    await waitFor(() =>
      expect(hub.socketPaths).toContain("/api/v1/machines/node-b/proxy/terminals"),
    );
    expect(node.socketsFor("/api/v1/terminals")[0]?.query.get("boxId")).toBe("aio-agent-batch");

    // Back on this PC, the same box id is another box, with no terminal open.
    await user.click(within(machineTabs()).getByRole("tab", { name: "main-pc (this PC)" }));
    await screen.findByRole("cell", { name: "Site work" });
    expect(screen.queryByRole("tablist", { name: "Terminals" })).toBeNull();
    fireEvent.doubleClick(rowOf("Site work"));
    const localTabs = await screen.findByRole("tablist", { name: "Terminals" });
    expect(within(localTabs).getAllByRole("tab")[0]).toHaveTextContent("main-pc / Site work");
    expect(local.socketsFor("/api/v1/terminals")[0]?.query.get("boxId")).toBe("aio-agent-site");
  });

  it("switches machine tabs with Ctrl+Shift+PageDown and Ctrl+Shift+PageUp", async () => {
    renderHub({
      local: siteServer(),
      servers: { "node-b": nodeServer() },
      machines: [LOCAL, machine({ id: "node-b", name: "node-b" })],
    });
    await screen.findByRole("tablist", { name: "Machines" });
    const key = (k: string) =>
      fireEvent.keyDown(window, { key: k, code: k, ctrlKey: true, shiftKey: true });
    key("PageDown");
    await waitFor(() =>
      expect(within(machineTabs()).getByRole("tab", { name: "node-b" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    key("PageUp");
    await waitFor(() =>
      expect(within(machineTabs()).getByRole("tab", { name: "main-pc (this PC)" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  it("opens a remote machine's shell in a tab and browses its directories, not this PC's", async () => {
    const user = userEvent.setup();
    const pickDirectory = vi.fn(async () => "/local/dir");
    const openExternalTerminal = vi.fn(async () => ({ ok: true }));
    window.aio = {
      takeToken: () => null,
      serverUrl: "http://127.0.0.1:21400",
      openExternalTerminal,
      launchReview: async () => ({ ok: true }),
      pickDirectory,
      readClipboardText: async () => "",
      openPath: async () => ({ ok: true }),
      openExternal: async () => ({ ok: true }),
      onSelectBox: () => () => undefined,
      quit: () => undefined,
    };
    const node = nodeServer();
    node.state.dirs = { "/home/user": ["node-only"], "/home/user/node-only": [] };
    renderHub({
      local: siteServer(),
      servers: { "node-b": node },
      machines: [LOCAL, machine({ id: "node-b", name: "node-b" })],
    });
    await user.click(
      await within(await screen.findByRole("tablist", { name: "Machines" })).findByRole("tab", {
        name: "node-b",
      }),
    );
    await screen.findByRole("cell", { name: "Node site" });
    fireEvent.mouseDown(rowOf("Node site"), { button: 0 });
    const toolbar = screen.getByRole("toolbar", { name: "Box actions" });
    await user.click(within(toolbar).getByRole("button", { name: "Open Shell" }));
    const terminals = await screen.findByRole("tablist", { name: "Terminals" });
    expect(within(terminals).getAllByRole("tab")[0]).toHaveTextContent(
      "node-b / Node site (shell)",
    );
    await waitFor(() => expect(node.socketsFor("/api/v1/terminals")).toHaveLength(1));
    expect(node.socketsFor("/api/v1/terminals")[0]?.query.get("kind")).toBe("shell");
    expect(openExternalTerminal).not.toHaveBeenCalled();

    await user.click(within(toolbar).getByRole("button", { name: "New" }));
    const dialog = await screen.findByRole("dialog", { name: "New Box" });
    await user.click(within(dialog).getAllByRole("button", { name: "Browse..." })[0]!);
    const picker = await screen.findByRole("dialog", { name: "Choose a Directory" });
    expect(await within(picker).findByRole("button", { name: "node-only/" })).toBeInTheDocument();
    expect(node.callsTo("fs.dirs").length).toBeGreaterThan(0);
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it("creates, edits, stops, and removes boxes on a remote machine with its own projects", async () => {
    const user = userEvent.setup();
    const local = siteServer();
    const node = nodeServer();
    // The node's project has a mount and this PC has no such project, so
    // the edit dialog can show it only from the node's project list.
    const nodeProject = node.state.projects.find((p) => p.root === "/srv/site");
    if (!nodeProject) throw new Error("The node has no /srv/site project.");
    nodeProject.mounts = [{ host: "/srv/data", container: "/data" }];
    const { hub } = renderHub({
      local,
      servers: { "node-b": node },
      machines: [LOCAL, machine({ id: "node-b", name: "node-b" })],
    });
    await user.click(
      await within(await screen.findByRole("tablist", { name: "Machines" })).findByRole("tab", {
        name: "node-b",
      }),
    );
    await screen.findByRole("cell", { name: "Node site" });
    await waitFor(() => expect(node.socketsFor("/api/v1/events")).toHaveLength(1));
    const toolbar = screen.getByRole("toolbar", { name: "Box actions" });

    // An event from the node changes its row.
    const batch = node.state.boxes.find((b) => b.box.id === "aio-agent-batch")!;
    act(() => {
      node.emit(
        makeEvent("box.changed", {
          boxId: batch.box.id,
          status: "stopped",
          box: { ...batch.box, conversationName: "Batch renamed" },
        }),
      );
    });
    expect(await screen.findByRole("cell", { name: "Batch renamed" })).toBeInTheDocument();

    // Edit: the dialog shows the node's project, and the save goes to the node.
    fireEvent.mouseDown(rowOf("Node site"), { button: 0 });
    await user.keyboard("{Control>}{Shift>}E{/Shift}{/Control}");
    const edit = await screen.findByRole("dialog", { name: "Edit Box" });
    await user.click(within(edit).getByRole("button", { name: /Add folders to sandbox/ }));
    expect(within(edit).getByLabelText("Host folder 1")).toHaveValue("/srv/data");
    await user.clear(within(edit).getByLabelText("Conversation name"));
    await user.type(within(edit).getByLabelText("Conversation name"), "Node site 2");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(node.callsTo("boxes.update")).toHaveLength(1));
    expect(hub.paths).toContain("PATCH /api/v1/machines/node-b/proxy/boxes/aio-agent-site");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Box" })).toBeNull());

    // Stop the running box.
    fireEvent.mouseDown(rowOf("Node site 2"), { button: 0 });
    await user.click(within(toolbar).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(node.callsTo("boxes.stop")).toHaveLength(1));
    expect(hub.paths).toContain("POST /api/v1/machines/node-b/proxy/boxes/aio-agent-site/stop");

    // Remove the stopped one.
    fireEvent.mouseDown(rowOf("Batch renamed"), { button: 0 });
    await user.click(within(toolbar).getByRole("button", { name: "Remove" }));
    const remove = await screen.findByRole("dialog", { name: "Remove" });
    await user.click(within(remove).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(node.callsTo("boxes.remove")).toHaveLength(1));

    // Create a box on the node.
    await user.click(within(toolbar).getByRole("button", { name: "New" }));
    const create = await screen.findByRole("dialog", { name: "New Box" });
    await user.clear(within(create).getByLabelText("Target directory"));
    await user.type(within(create).getByLabelText("Target directory"), "/srv/new");
    await user.click(within(create).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(node.callsTo("boxes.create")).toHaveLength(1));
    expect(node.callsTo("boxes.create")[0]?.body).toMatchObject({ targetDir: "/srv/new" });

    // Nothing reached this PC's server.
    for (const key of ["boxes.update", "boxes.stop", "boxes.remove", "boxes.create"] as const) {
      expect(local.callsTo(key)).toHaveLength(0);
    }
    expect(node.contractViolations).toEqual([]);
  });

  it("says a machine is offline when the hub can't reach it", async () => {
    const user = userEvent.setup();
    // The hub lists node-d as online, but its link answers machine_offline.
    renderHub({
      local: siteServer(),
      machines: [LOCAL, machine({ id: "node-d", name: "node-d" })],
    });
    await user.click(
      await within(await screen.findByRole("tablist", { name: "Machines" })).findByRole("tab", {
        name: "node-d",
      }),
    );
    expect(await screen.findByText(/node-d is offline: the hub can.t reach it/)).toBeVisible();
  });

  it("shows an offline machine's state and last-seen time", async () => {
    const user = userEvent.setup();
    renderHub({
      local: siteServer(),
      machines: [LOCAL, machine({ id: "node-c", name: "node-c", status: "offline" })],
    });
    await user.click(
      await within(await screen.findByRole("tablist", { name: "Machines" })).findByRole("tab", {
        name: "node-c",
      }),
    );
    const status = (await screen.findByText(/node-c is offline/)).closest(
      ".bx-machine-offline",
    ) as HTMLElement;
    expect(status).toHaveTextContent("node-c is offline");
    expect(status).toHaveTextContent(`Last seen ${relativeTime(T_SEEN)}`);
    expect(screen.queryByRole("toolbar", { name: "Box actions" })).toBeNull();
  });
});

describe("Machines page", () => {
  async function openPage(machines: Machine[]) {
    const user = userEvent.setup();
    const utils = renderHub({ local: siteServer(), servers: { "node-b": nodeServer() }, machines });
    await user.click(
      await within(await screen.findByRole("tablist", { name: "Machines" })).findByRole("tab", {
        name: "Machines",
      }),
    );
    await screen.findByRole("table", { name: "Machines" });
    return { user, ...utils };
  }

  it("lists each machine's status, role, platform, versions, and capabilities", async () => {
    await openPage([LOCAL, machine({ id: "node-b", name: "node-b", platform: "linux" })]);
    const table = screen.getByRole("table", { name: "Machines" });
    const row = machineRow("node-b");
    expect(row).toHaveTextContent("Online");
    expect(row).toHaveTextContent("Node");
    expect(row).toHaveTextContent("Linux");
    expect(row).toHaveTextContent("1.1.0");
    expect(row).toHaveTextContent("boxes, terminals");
    expect(within(table).getByText("this PC")).toBeInTheDocument();
  });

  it("opens from the File menu on a single-machine install, and goes back", async () => {
    const user = userEvent.setup();
    renderHub({ local: siteServer(), machines: [LOCAL] });
    await screen.findByRole("cell", { name: "Site work" });
    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "File" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Machines\.\.\./ }));
    await screen.findByRole("table", { name: "Machines" });
    await user.click(within(machineTabs()).getByRole("tab", { name: "main-pc (this PC)" }));
    await screen.findByRole("cell", { name: "Site work" });
    expect(screen.queryByRole("tablist", { name: "Machines" })).toBeNull();
  });

  it("shows an enrollment code with the join command", async () => {
    const { user, hub } = await openPage([LOCAL, machine({ id: "node-b", name: "node-b" })]);
    await user.click(screen.getByRole("button", { name: "Add Machine..." }));
    const dialog = await screen.findByRole("dialog", { name: "Add Machine" });
    expect(hub.codes).toBe(1);
    expect(within(dialog).getByLabelText("Enrollment command")).toHaveValue(
      "aio node join https://hub.example.com:21400 ABCD-1234",
    );
    await user.click(within(dialog).getByRole("button", { name: "Copy Command" }));
    expect(await navigator.clipboard.readText()).toBe(
      "aio node join https://hub.example.com:21400 ABCD-1234",
    );
  });

  it("revokes a machine after confirmation", async () => {
    const { user, hub } = await openPage([LOCAL, machine({ id: "node-b", name: "node-b" })]);
    const table = screen.getByRole("table", { name: "Machines" });
    const revoke = screen.getByRole("button", { name: "Revoke..." });
    // This PC can't be revoked.
    fireEvent.mouseDown(
      within(table)
        .getByRole("cell", { name: /main-pc/ })
        .closest("tr")!,
      {
        button: 0,
      },
    );
    expect(revoke).toBeDisabled();
    fireEvent.mouseDown(machineRow("node-b"), {
      button: 0,
    });
    expect(revoke).toBeEnabled();
    await user.click(revoke);
    const confirm = await screen.findByRole("dialog", { name: "Revoke Machine" });
    expect(confirm).toHaveTextContent('Revoke "node-b"?');
    await user.click(within(confirm).getByRole("button", { name: "No" }));
    expect(hub.revoked).toEqual([]);
    await user.click(revoke);
    await user.click(
      within(await screen.findByRole("dialog", { name: "Revoke Machine" })).getByRole("button", {
        name: "Yes",
      }),
    );
    await waitFor(() => expect(hub.revoked).toEqual(["node-b"]));
    expect(hub.paths).toContain("DELETE /api/v1/machines/node-b");
    // The revoked machine loses its tab.
    await waitFor(() =>
      expect(within(machineTabs()).queryByRole("tab", { name: "node-b" })).toBeNull(),
    );
  });

  it("notes a machine with another protocol or missing capabilities", async () => {
    await openPage([
      { ...LOCAL, protocol: 2, capabilities: ["boxes", "terminals", "fleet-events"] },
      machine({ id: "node-b", name: "node-b", protocol: 1, capabilities: ["boxes"] }),
    ]);
    expect(screen.getByRole("note")).toHaveTextContent(
      "node-b runs a different server version from this PC.",
    );
    const row = machineRow("node-b");
    expect(row).toHaveTextContent("Update aio-server on node-b");
    expect(row).toHaveTextContent("It lacks terminals, fleet-events.");
  });
});

describe("machine logic", () => {
  it("sorts this PC first, then by name", () => {
    expect(
      sortMachines([machine({ id: "b", name: "b" }), LOCAL, machine({ id: "a", name: "a" })]).map(
        (m) => m.id,
      ),
    ).toEqual(["local", "a", "b"]);
  });

  it("formats relative times", () => {
    const now = new Date("2026-10-31T10:00:00.000Z");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("2026-10-31T09:59:50.000Z", now)).toBe("just now");
    expect(relativeTime("2026-10-31T09:59:00.000Z", now)).toBe("1 minute ago");
    expect(relativeTime(T_SEEN, now)).toBe("2 hours ago");
    expect(relativeTime("2026-10-28T10:00:00.000Z", now)).toBe("3 days ago");
    expect(lastSeenText(machine({ id: "x", name: "x", lastSeen: null }), now)).toBe("never");
  });

  it("finds no skew for matching machines or this PC", () => {
    expect(skewNotes(machine({ id: "b", name: "b" }), { ...LOCAL })).toEqual([]);
    expect(skewNotes(LOCAL, LOCAL)).toEqual([]);
    expect(
      skewNotes(machine({ id: "b", name: "b", protocol: 3 }), { ...LOCAL, protocol: 2 })[0],
    ).toContain("Update aio-server on this PC.");
  });
});
