// The setup wizard's machine role step: a single machine, a hub, or a node
// that joins a hub with a one-time enrollment code.
import type { NodeStatus } from "@aio/contracts";
import { FakeApiError, FakeServer } from "@aio/ui/testing";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SetupWizard } from "../src/dialogs/SetupWizard";
import { parseJoinInput } from "../src/logic/machines";
import { renderWithServer } from "./helpers";

const HUB = "https://hub.example.com:21402";
const CODE = "7K2Q-M9XD-4HPA-R3TB";

function status(extra: Partial<NodeStatus> = {}): NodeStatus {
  return {
    role: "both",
    name: "workstation",
    machineId: null,
    hubUrl: null,
    link: "none",
    error: null,
    linkPort: null,
    ...extra,
  };
}

function serverWith(node: NodeStatus): FakeServer {
  const server = new FakeServer({ settings: { setupCompleted: false } });
  server.on("node.get", () => node);
  server.on("node.join", (r) => {
    const body = r.body as { hubUrl: string; code: string; name?: string };
    if (body.code !== CODE) throw new FakeApiError("unauthorized", "The code is wrong.", 401);
    return status({
      role: "node",
      name: body.name ?? node.name,
      machineId: "m1",
      hubUrl: body.hubUrl,
      link: "connected",
    });
  });
  return server;
}

describe("parseJoinInput", () => {
  it("reads a hub URL alone or the whole join command", () => {
    expect(parseJoinInput(` ${HUB} `)).toEqual({ hubUrl: HUB });
    expect(parseJoinInput(`aio node join ${HUB}`)).toEqual({ hubUrl: HUB });
    expect(parseJoinInput(`aio node join ${HUB} ${CODE}`)).toEqual({ hubUrl: HUB, code: CODE });
    expect(parseJoinInput(`${HUB} ${CODE}`)).toEqual({ hubUrl: HUB, code: CODE });
  });

  it("refuses anything that isn't an HTTPS hub URL", () => {
    expect(parseJoinInput("")).toBeNull();
    expect(parseJoinInput("hub.example.com")).toBeNull();
    expect(parseJoinInput("http://hub.example.com:21402")).toBeNull();
    expect(parseJoinInput(`aio node join ${HUB} ${CODE} extra`)).toBeNull();
  });
});

describe("SetupWizard machine role", () => {
  it("keeps a single machine as it is on Done", async () => {
    const user = userEvent.setup();
    const server = serverWith(status());
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    const group = await screen.findByRole("group", { name: "This machine" });
    expect(within(group).getByRole("radio", { name: /Single machine/ })).toBeChecked();
    expect(screen.queryByLabelText("Hub URL")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.callsTo("node.join")).toHaveLength(0);
    expect(server.callsTo("settings.patch")).toHaveLength(0);
    expect(server.state.settings.setupCompleted).toBe(true);
  });

  it("joins a hub with the pasted join command and a name on Done", async () => {
    const user = userEvent.setup();
    const server = serverWith(status());
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    await user.click(await screen.findByRole("radio", { name: /Node: join a hub/ }));
    await user.click(screen.getByLabelText("Hub URL"));
    await user.paste(`aio node join ${HUB}`);
    expect(screen.getByLabelText("Hub URL")).toHaveValue(HUB);
    expect(screen.getByLabelText("Enrollment code")).toHaveValue("");
    await user.type(screen.getByLabelText("Enrollment code"), CODE);
    await user.type(screen.getByLabelText("Machine name (optional)"), "build-node");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.callsTo("node.join").map((c) => c.body)).toEqual([
      { hubUrl: HUB, code: CODE, name: "build-node" },
    ]);
    expect(server.state.settings.setupCompleted).toBe(true);
  });

  it("stays open and saves nothing when the join fails", async () => {
    const user = userEvent.setup();
    const server = serverWith(status());
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    await user.click(await screen.findByRole("radio", { name: /Node: join a hub/ }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the hub URL");
    await user.type(screen.getByLabelText("Hub URL"), HUB);
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Enter the enrollment code"),
    );
    await user.type(screen.getByLabelText("Enrollment code"), "WRONG-CODE");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The code is wrong."));
    expect(onClose).not.toHaveBeenCalled();
    expect(server.state.settings.setupCompleted).toBe(false);
  });

  it("shows the hub link of a machine that already joined", async () => {
    const server = serverWith(
      status({ role: "node", machineId: "m1", hubUrl: HUB, link: "connected" }),
    );
    renderWithServer(<SetupWizard onClose={() => undefined} />, server);
    expect(
      await screen.findByText(`A node of the hub at ${HUB}, as workstation. Link: connected.`),
    ).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("offers single machine, hub, and node", async () => {
    renderWithServer(<SetupWizard onClose={() => undefined} />, serverWith(status()));
    const group = await screen.findByRole("group", { name: "This machine" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(["single", "hub", "join"]);
  });

  it("stores the hub role on Done when the user picks Hub", async () => {
    const user = userEvent.setup();
    const server = serverWith(status());
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    await user.click(await screen.findByRole("radio", { name: /^Hub:/ }));
    expect(screen.getByText(/Nodes can't see or reach boxes on a hub/)).toBeVisible();
    expect(screen.getByText(/applies at the next server start/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Hub URL")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.callsTo("settings.patch").map((c) => c.body)).toEqual([{ role: "hub" }]);
    expect(server.state.settings.role).toBe("hub");
    expect(server.callsTo("node.join")).toHaveLength(0);
    expect(server.state.settings.setupCompleted).toBe(true);
  });

  it("keeps a hub as it is on Done and points it at the Machines page", async () => {
    const user = userEvent.setup();
    const server = serverWith(status({ role: "hub" }));
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    expect(await screen.findByRole("radio", { name: /^Hub:/ })).toBeChecked();
    expect(screen.getByText(/issue an enrollment code on the Machines page/)).toBeVisible();
    expect(screen.queryByText(/applies at the next server start/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.callsTo("settings.patch")).toHaveLength(0);
  });

  it("sets a hub back to both when the user picks a single machine", async () => {
    const user = userEvent.setup();
    const server = serverWith(status({ role: "hub" }));
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    await user.click(await screen.findByRole("radio", { name: /Single machine/ }));
    expect(screen.getByText(/runs as a hub. Done sets its role to both/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.state.settings.role).toBe("both");
  });

  it("joins from a hub without patching the role, and retries after a failed join", async () => {
    const user = userEvent.setup();
    const server = serverWith(status({ role: "hub" }));
    server.state.settings.role = "hub";
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    await user.click(await screen.findByRole("radio", { name: /Node: join a hub/ }));
    await user.type(screen.getByLabelText("Hub URL"), HUB);
    await user.type(screen.getByLabelText("Enrollment code"), "WRONG-CODE");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The code is wrong."));
    expect(server.callsTo("settings.patch")).toHaveLength(0);
    expect(server.state.settings.role).toBe("hub");
    await user.clear(screen.getByLabelText("Enrollment code"));
    await user.type(screen.getByLabelText("Enrollment code"), CODE);
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.callsTo("node.join").map((c) => c.body)).toEqual([
      { hubUrl: HUB, code: "WRONG-CODE", leaveHubRole: true },
      { hubUrl: HUB, code: CODE, leaveHubRole: true },
    ]);
    expect(server.callsTo("settings.patch")).toHaveLength(0);
  });

  it("sends one join and turns Done off while the join runs", async () => {
    const user = userEvent.setup();
    const server = serverWith(status({ role: "hub" }));
    let finish: (value: NodeStatus) => void = () => undefined;
    server.on("node.join", () => new Promise<NodeStatus>((resolve) => (finish = resolve)));
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    await user.click(await screen.findByRole("radio", { name: /Node: join a hub/ }));
    await user.type(screen.getByLabelText("Hub URL"), HUB);
    await user.type(screen.getByLabelText("Enrollment code"), CODE);
    const done = screen.getByRole("button", { name: "Done" });
    await user.dblClick(done);
    await waitFor(() => expect(server.callsTo("node.join")).toHaveLength(1));
    expect(done).toBeDisabled();
    await user.click(done);
    finish(status({ role: "node", machineId: "m1", hubUrl: HUB, link: "connected" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.callsTo("node.join")).toHaveLength(1);
    expect(server.callsTo("settings.patch")).toHaveLength(0);
  });

  it("turns Done on again after a failed save", async () => {
    const user = userEvent.setup();
    renderWithServer(
      <SetupWizard onClose={() => undefined} />,
      serverWith(status({ role: "hub" })),
    );
    await user.click(await screen.findByRole("radio", { name: /Node: join a hub/ }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  });

  it.each(["single", "hub"] as const)(
    "stores no role for the %s choice under a role override",
    async (choice) => {
      const user = userEvent.setup();
      const role = choice === "hub" ? "node" : "hub";
      const server = serverWith(status({ role, roleOverride: role }));
      const onClose = vi.fn();
      renderWithServer(<SetupWizard onClose={onClose} />, server);
      await user.click(
        await screen.findByRole("radio", { name: choice === "hub" ? /^Hub:/ : /Single machine/ }),
      );
      expect(screen.getByText(/runs with --role/)).toBeVisible();
      expect(screen.queryByText(/next server start/)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(server.callsTo("settings.patch")).toHaveLength(0);
    },
  );

  it("patches no role when a join fails under a role override", async () => {
    const user = userEvent.setup();
    const server = serverWith(status({ role: "hub", roleOverride: "hub" }));
    server.on("node.join", () => {
      throw new FakeApiError("invalid_state", "This server runs with --role hub.", 409);
    });
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    await user.click(await screen.findByRole("radio", { name: /Node: join a hub/ }));
    await user.type(screen.getByLabelText("Hub URL"), HUB);
    await user.type(screen.getByLabelText("Enrollment code"), CODE);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("runs with --role hub");
    expect(server.callsTo("settings.patch")).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sets a node that never joined back to both when the user picks a single machine", async () => {
    const user = userEvent.setup();
    const server = serverWith(status({ role: "node" }));
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    expect(await screen.findByRole("radio", { name: /Node: join a hub/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /Single machine/ }));
    expect(screen.getByText(/applies at the next server start/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.state.settings.role).toBe("both");
  });

  it("hides the step on a server without multi-host routes", async () => {
    const server = new FakeServer();
    renderWithServer(<SetupWizard onClose={() => undefined} />, server);
    await screen.findByText("Docker reachable");
    await waitFor(() => expect(server.callsTo("node.get")).toHaveLength(1));
    expect(screen.queryByRole("group", { name: "This machine" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
