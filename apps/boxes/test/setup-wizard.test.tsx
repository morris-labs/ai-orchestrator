// The setup wizard's machine role step: a single machine, or a node that
// joins a hub with a one-time enrollment code.
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
    await user.paste(`aio node join ${HUB} ${CODE}`);
    expect(screen.getByLabelText("Hub URL")).toHaveValue(HUB);
    expect(screen.getByLabelText("Enrollment code")).toHaveValue(CODE);
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

  it("points a hub at the Machines page", async () => {
    const server = serverWith(status({ role: "hub" }));
    renderWithServer(<SetupWizard onClose={() => undefined} />, server);
    expect(await screen.findByText(/issue an enrollment code on the Machines page/)).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
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
