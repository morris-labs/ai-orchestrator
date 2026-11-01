import type { SecretCandidate } from "@aio/contracts";
import { FakeServer, makeBoxView, makeProject } from "@aio/ui/testing";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BoxDialog, type BoxDialogResult } from "../src/dialogs/BoxDialog";
import {
  freeName,
  groupCandidates,
  refsToSave,
  secretProblems,
  selectionFromRefs,
  tick,
  untick,
} from "../src/logic/secrets";
import { renderWithServer } from "./helpers";

function cand(item: string, field: string, name: string, section?: string): SecretCandidate {
  return {
    vault: "Aio",
    item,
    itemId: item.toLowerCase().replace(/\W+/g, ""),
    field,
    ...(section ? { section } : {}),
    type: "CONCEALED",
    ref: `op://Aio/${item}/${section ? `${section}/` : ""}${field}`,
    suggestedName: name,
  };
}

const GITHUB = cand("Token GitHub", "credential", "TOKEN_GITHUB_CREDENTIAL");
const DB = cand("Orders DB", "url", "ORDERS_DB_URL");
const GLOBAL = cand("Shared", "key", "SHARED_KEY");

describe("secrets logic", () => {
  it("groups by item and filters", () => {
    const all = [GITHUB, DB, cand("Orders DB", "password", "ORDERS_DB_PASSWORD")];
    expect(groupCandidates(all, "").map((g) => [g.item, g.rows.length])).toEqual([
      ["Token GitHub", 1],
      ["Orders DB", 2],
    ]);
    expect(groupCandidates(all, "orders pass")[0]?.rows).toHaveLength(1);
    expect(groupCandidates(all, "nothing")).toEqual([]);
  });

  it("keeps ticked names unique", () => {
    expect(freeName("A", ["A", "A_2"])).toBe("A_3");
    const sel = tick(tick({}, GITHUB), { ...DB, suggestedName: "TOKEN_GITHUB_CREDENTIAL" });
    expect(Object.values(sel)).toEqual(["TOKEN_GITHUB_CREDENTIAL", "TOKEN_GITHUB_CREDENTIAL_2"]);
    expect(untick(sel, GITHUB.ref)).toEqual({ [DB.ref]: "TOKEN_GITHUB_CREDENTIAL_2" });
  });

  it("flags bad and repeated names", () => {
    expect(secretProblems({ a: "OK", b: "OK" })).toEqual(["The secret name OK is used twice."]);
    expect(secretProblems({ a: "1BAD" })[0]).toContain("must start with a letter");
    expect(secretProblems({ a: "GOOD_1" })).toEqual([]);
  });

  it("saves nothing when the selection matches, else keeps order and appends", () => {
    const saved = [
      { name: "A", ref: "op://v/a/1" },
      { name: "B", ref: "op://v/b/1" },
    ];
    expect(refsToSave(selectionFromRefs(saved), saved)).toBeNull();
    expect(refsToSave({ "op://v/b/1": "B2", "op://v/c/1": "C", "op://v/a/1": "A" }, saved)).toEqual(
      [
        { name: "A", ref: "op://v/a/1" },
        { name: "B2", ref: "op://v/b/1" },
        { name: "C", ref: "op://v/c/1" },
      ],
    );
  });
});

function editDialog(server: FakeServer) {
  const view = makeBoxView({ box: { id: "aio-agent-site", targetDir: "/w/site" } });
  server.state.boxes.push(view);
  const onAccept = vi.fn(async (_r: BoxDialogResult) => null as string | null);
  renderWithServer(
    <BoxDialog
      mode="edit"
      source={view}
      projects={server.state.projects}
      settings={server.state.settings}
      initialDir="/w/site"
      onAccept={onAccept}
      onCancel={() => undefined}
      onManageRemotes={() => undefined}
    />,
    server,
  );
  return onAccept;
}

function serverWithProject() {
  const server = new FakeServer({
    projects: [
      makeProject({
        root: "/w/site",
        name: "site",
        secretRefs: [
          { name: "GONE", ref: "op://Aio/Old item/credential" },
          { name: "ORDERS_DB_URL", ref: DB.ref },
        ],
      }),
    ],
    settings: { secretRefs: [{ name: "SHARED", ref: GLOBAL.ref }] },
  });
  server.state.secretCandidates = [GITHUB, DB, GLOBAL];
  return server;
}

describe("BoxDialog secrets section", () => {
  it("shows project, global and missing references and returns the edited list", async () => {
    const user = userEvent.setup();
    const server = serverWithProject();
    const onAccept = editDialog(server);
    await user.click(screen.getByRole("button", { name: /Secrets \(project\)/ }));
    expect(screen.getByText(/apply to every box in "site"/)).toBeInTheDocument();

    const github = await screen.findByLabelText("Token GitHub credential");
    expect(github).not.toBeChecked();
    expect(screen.getByLabelText("Orders DB url")).toBeChecked();
    // A global reference is ticked and locked, and its name is read-only here.
    const shared = screen.getByLabelText("Shared key");
    expect(shared).toBeChecked();
    expect(shared).toBeDisabled();
    expect(screen.getByLabelText("Global SHARED")).toBeDisabled();
    // A reference that 1Password no longer lists stays, marked missing.
    expect(screen.getByLabelText("Missing GONE")).toBeChecked();

    await user.click(github);
    const name = screen.getByLabelText("Name for Token GitHub credential");
    expect(name).toHaveValue("TOKEN_GITHUB_CREDENTIAL");
    await user.clear(name);
    await user.type(name, "GH_TOKEN");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onAccept).toHaveBeenCalled());
    expect((onAccept.mock.calls[0]?.[0] as BoxDialogResult).secretRefs).toEqual([
      { name: "GONE", ref: "op://Aio/Old item/credential" },
      { name: "ORDERS_DB_URL", ref: DB.ref },
      { name: "GH_TOKEN", ref: GITHUB.ref },
    ]);
  });

  it("removes a missing reference when it is unticked, and sends null when nothing changed", async () => {
    const user = userEvent.setup();
    const server = serverWithProject();
    const onAccept = editDialog(server);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
    expect((onAccept.mock.calls[0]?.[0] as BoxDialogResult).secretRefs).toBeNull();

    await user.click(screen.getByRole("button", { name: /Secrets \(project\)/ }));
    await user.click(await screen.findByLabelText("Missing GONE"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(2));
    expect((onAccept.mock.calls[1]?.[0] as BoxDialogResult).secretRefs).toEqual([
      { name: "ORDERS_DB_URL", ref: DB.ref },
    ]);
  });

  it("refuses a bad name", async () => {
    const user = userEvent.setup();
    const onAccept = editDialog(serverWithProject());
    await user.click(screen.getByRole("button", { name: /Secrets \(project\)/ }));
    await user.click(await screen.findByLabelText("Token GitHub credential"));
    const name = screen.getByLabelText("Name for Token GitHub credential");
    await user.clear(name);
    await user.type(name, "bad name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("must start with a letter");
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("filters, and refresh bypasses the cache", async () => {
    const user = userEvent.setup();
    const server = serverWithProject();
    editDialog(server);
    await user.click(screen.getByRole("button", { name: /Secrets \(project\)/ }));
    await screen.findByLabelText("Token GitHub credential");
    await user.type(screen.getByLabelText("Filter secrets"), "orders");
    expect(screen.queryByLabelText("Token GitHub credential")).toBeNull();
    expect(screen.getByLabelText("Orders DB url")).toBeInTheDocument();
    expect(server.callsTo("secrets.available").map((c) => c.query.refresh)).toEqual([false]);
    await user.click(screen.getByRole("button", { name: "Refresh secrets" }));
    await waitFor(() =>
      expect(server.callsTo("secrets.available").map((c) => c.query.refresh)).toEqual([
        false,
        true,
      ]),
    );
  });

  it("explains a locked 1Password and keeps the saved references", async () => {
    const user = userEvent.setup();
    const server = serverWithProject();
    server.state.secretsError = "secrets_locked";
    const onAccept = editDialog(server);
    await user.click(screen.getByRole("button", { name: /Secrets \(project\)/ }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/1Password is not available/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalled());
    expect((onAccept.mock.calls[0]?.[0] as BoxDialogResult).secretRefs).toBeNull();
  });
});
