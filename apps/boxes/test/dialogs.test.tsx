import type { ConversationSummary, Effort, Job } from "@agentbox/contracts";
import { FakeServer, makeBoxView, makeProject } from "@agentbox/ui/testing";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BoxDialog, type BoxDialogResult } from "../src/dialogs/BoxDialog";
import { JobDialog, jobLabel, waitForJob } from "../src/dialogs/JobDialog";
import { MountsDialog } from "../src/dialogs/MountsDialog";
import { PromptsDialog } from "../src/dialogs/PromptsDialog";
import { SetupWizard } from "../src/dialogs/SetupWizard";
import { SshRemoteDialog, remoteProblems } from "../src/dialogs/SshDialogs";
import { updateBody } from "../src/logic/newBox";
import { renderWithServer } from "./helpers";

const UUID1 = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const UUID3 = "33333333-3333-4333-8333-333333333333";

function conv(uuid: string, title: string): ConversationSummary {
  return {
    sessionUuid: uuid,
    title,
    titleSource: "ai-title",
    turns: 4,
    modifiedAt: "2026-10-28T08:00:00Z",
    sizeBytes: 100,
    lastPrompt: "make it work",
    trackedBy: [],
  };
}

function newDialog(server: FakeServer, overrides: Partial<Parameters<typeof BoxDialog>[0]> = {}) {
  const onAccept = vi.fn(async (_r: BoxDialogResult) => null as string | null);
  const onCancel = vi.fn();
  const utils = renderWithServer(
    <BoxDialog
      mode="new"
      projects={server.state.projects}
      settings={server.state.settings}
      initialDir=""
      onAccept={onAccept}
      onCancel={onCancel}
      onManageRemotes={() => undefined}
      {...overrides}
    />,
    server,
  );
  return { onAccept, onCancel, ...utils };
}

describe("BoxDialog, new mode", () => {
  it("browses the host's directories through fs.dirs without Electron", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    newDialog(server);
    await user.click(screen.getAllByRole("button", { name: "Browse..." })[0]!);
    const picker = await screen.findByRole("dialog", { name: "Choose a Directory" });
    expect(within(picker).getByLabelText("Path")).toHaveValue("/home/user");
    await user.click(within(picker).getByRole("button", { name: "src/" }));
    await waitFor(() =>
      expect(within(picker).getByLabelText("Path")).toHaveValue("/home/user/src"),
    );
    await user.click(within(picker).getByRole("button", { name: "example-app/" }));
    await waitFor(() =>
      expect(within(picker).getByRole("button", { name: ".." })).toBeInTheDocument(),
    );
    await user.click(within(picker).getByRole("button", { name: "Choose" }));
    expect(screen.queryByRole("dialog", { name: "Choose a Directory" })).toBeNull();
    expect(screen.getByLabelText("Target directory")).toHaveValue("/home/user/src/example-app");
    expect(server.callsTo("fs.dirs").map((c) => c.query.path)).toEqual([
      undefined,
      "/home/user/src",
      "/home/user/src/example-app",
    ]);
  });

  it("refuses a missing or relative directory", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { onAccept } = newDialog(server);
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a target directory.");
    await user.type(screen.getByLabelText("Target directory"), "relative/dir");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("must be an absolute path");
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("needs a name for a worktree, and defaults to a worktree for a repository", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: [] });
    server.state.projects.push(makeProject({ root: "/w/site", primaryRepo: "/w/site" }));
    const { onAccept } = newDialog(server, {
      projects: server.state.projects,
      initialDir: "/w/site",
    });
    expect(screen.getByLabelText("In a git worktree on its own branch")).toBeChecked();
    await user.type(screen.getByLabelText("Conversation name"), "!!");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "worktree is named after the conversation",
    );
    await user.clear(screen.getByLabelText("Conversation name"));
    await user.type(screen.getByLabelText("Conversation name"), "Emails not sending!");
    expect(
      screen.getByText(
        "Worktree .worktrees/Emails_not_sending on branch claude/Emails_not_sending.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalled());
    const r = onAccept.mock.calls[0]?.[0] as BoxDialogResult;
    expect(r.form).toMatchObject({
      targetDir: "/w/site",
      layout: "worktree",
      name: "Emails not sending!",
    });
    expect(r.project).toBeNull();
  });

  it("disables the worktree for a project without a repository", () => {
    const server = new FakeServer();
    server.state.projects.push(makeProject({ root: "/w/plain" }));
    newDialog(server, { projects: server.state.projects, initialDir: "/w/plain" });
    expect(screen.getByLabelText(/In a git worktree/)).toBeDisabled();
    expect(screen.getByLabelText("In the directory itself")).toBeChecked();
  });

  it("fills the name from a picked conversation without overwriting typed text", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({
      conversations: { "/w/site": [conv(UUID1, "Fix login"), conv(UUID2, "Speed up")] },
    });
    newDialog(server, { initialDir: "/w/site" });
    const combo = screen.getByLabelText("Conversation");
    await screen.findByRole("option", { name: /Fix login/ });
    await user.selectOptions(combo, UUID1);
    expect(screen.getByLabelText("Conversation name")).toHaveValue("Fix login");
    await user.selectOptions(combo, UUID2);
    expect(screen.getByLabelText("Conversation name")).toHaveValue("Speed up");
    await user.clear(screen.getByLabelText("Conversation name"));
    await user.type(screen.getByLabelText("Conversation name"), "Mine");
    await user.selectOptions(combo, UUID1);
    expect(screen.getByLabelText("Conversation name")).toHaveValue("Mine");
  });

  it("takes the model and effort defaults from the server for the directory", async () => {
    const server = new FakeServer();
    server.on("models.list", () => ({
      models: ["claude-opus-5-5", "claude-pinned-9"],
      efforts: ["low", "medium", "high", "xhigh", "max"] as const satisfies Effort[],
      defaults: { model: "claude-pinned-9", effort: "max" as const },
      source: "cache" as const,
    }));
    newDialog(server, { initialDir: "/w/site" });
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("claude-pinned-9"));
    expect(screen.getByLabelText("Effort")).toHaveValue("max");
  });

  it("turns off the model, effort, and conversation for other platforms", async () => {
    const user = userEvent.setup();
    newDialog(new FakeServer(), { initialDir: "/w/site" });
    await user.selectOptions(screen.getByLabelText("Platform"), "codex");
    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(screen.getByLabelText("Effort")).toBeDisabled();
    expect(screen.getByLabelText("Conversation")).toBeDisabled();
  });

  it("checks the project port maps and folders it edits", async () => {
    const user = userEvent.setup();
    const { onAccept } = newDialog(new FakeServer(), { initialDir: "/w/site" });
    await user.click(screen.getByRole("button", { name: /TCP port maps/ }));
    await user.click(screen.getByRole("button", { name: "Add port" }));
    await user.type(screen.getByLabelText("Host port 1"), "99999");
    await user.click(screen.getByRole("button", { name: /Add folders to sandbox/ }));
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    await user.type(screen.getByLabelText("Host folder 1"), "data");
    await user.click(screen.getByRole("button", { name: "Create" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("is not a port number");
    expect(alert).toHaveTextContent("the host path must be absolute");
    expect(onAccept).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Host port 1"));
    await user.type(screen.getByLabelText("Host port 1"), "8080");
    await user.clear(screen.getByLabelText("Host folder 1"));
    await user.type(screen.getByLabelText("Host folder 1"), "/data");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalled());
    expect((onAccept.mock.calls[0]?.[0] as BoxDialogResult).project).toEqual({
      tcpMaps: [{ host: 8080, container: 8080 }],
      mounts: [{ host: "/data", container: "/data" }],
    });
  });

  it("shows an error the save returns and stays open", async () => {
    const user = userEvent.setup();
    const { onAccept } = newDialog(new FakeServer(), { initialDir: "/w/site" });
    onAccept.mockResolvedValueOnce("claude-agent-x is already running this conversation.");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already running this conversation");
    expect(screen.getByRole("dialog", { name: "New Box" })).toBeInTheDocument();
  });
});

describe("BoxDialog, double submit", () => {
  it("submits once when Enter is pressed twice, and disables the form meanwhile", async () => {
    const user = userEvent.setup();
    let finish: (v: string | null) => void = () => undefined;
    const { onAccept } = newDialog(new FakeServer(), { initialDir: "/w/site" });
    onAccept.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          finish = resolve;
        }),
    );
    const name = screen.getByLabelText("Conversation name");
    await user.type(name, "Fix login{Enter}{Enter}");
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Conversation name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    finish("Try again.");
    await waitFor(() => expect(screen.getByLabelText("Conversation name")).toBeEnabled());
    await user.type(screen.getByLabelText("Conversation name"), "{Enter}");
    expect(onAccept).toHaveBeenCalledTimes(2);
  });
});

describe("BoxDialog, edit and fork modes", () => {
  const view = makeBoxView({
    box: {
      id: "claude-agent-site",
      targetDir: "/w/site",
      conversationName: "Site",
      sessionUuid: UUID3,
      workspace: "/w/site/Site",
    },
  });

  it("locks the directory and layout and shows a session with no transcript", async () => {
    const server = new FakeServer({
      boxes: [view],
      conversations: { "/w/site": [conv(UUID1, "Fix login")] },
    });
    renderWithServer(
      <BoxDialog
        mode="edit"
        source={view}
        projects={server.state.projects}
        settings={server.state.settings}
        initialDir="/w/site"
        onAccept={async () => null}
        onCancel={() => undefined}
        onManageRemotes={() => undefined}
      />,
      server,
    );
    expect(screen.getByLabelText("Target directory")).toBeDisabled();
    expect(screen.getByLabelText(/workspace subfolder/)).toBeChecked();
    expect(screen.getByLabelText(/workspace subfolder/)).toBeDisabled();
    const combo = screen.getByLabelText("Conversation");
    expect(
      within(combo).getByRole("option", { name: `Current: ${UUID3} (no transcript found)` }),
    ).toBeInTheDocument();
    expect(
      within(combo).getByRole("option", { name: "Start a new conversation on next restart" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("doesn't pin a model or effort the record leaves to the settings", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ boxes: [view] });
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
    await user.clear(screen.getByLabelText("Conversation name"));
    await user.type(screen.getByLabelText("Conversation name"), "Renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
    const r = onAccept.mock.calls[0]![0];
    expect(r.handPicked).toEqual({ model: false, effort: false });
    expect(updateBody(view.box, r.form, r.handPicked)).toEqual({ conversationName: "Renamed" });
  });

  it("names a fork after its source and disables the conversation", () => {
    const server = new FakeServer({ boxes: [view] });
    renderWithServer(
      <BoxDialog
        mode="fork"
        source={view}
        projects={server.state.projects}
        settings={server.state.settings}
        initialDir="/w/site"
        onAccept={async () => null}
        onCancel={() => undefined}
        onManageRemotes={() => undefined}
      />,
      server,
    );
    expect(screen.getByLabelText("Conversation name")).toHaveValue("Site (fork)");
    expect(screen.getByLabelText("Conversation")).toBeDisabled();
    expect(
      screen.getByText(/The fork starts a new session copied from "Site"/),
    ).toBeInTheDocument();
  });
});

describe("PromptsDialog", () => {
  it("edits, resets, and turns a template off with an empty text", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const onClose = vi.fn();
    renderWithServer(<PromptsDialog onClose={onClose} />, server);
    await user.click(await screen.findByRole("tab", { name: "Starter" }));
    const editor = screen.getByLabelText("Starter template");
    await waitFor(() => expect(editor).not.toBeDisabled());
    const reset = screen.getByRole("button", { name: "Reset to default" });
    expect(reset).toBeDisabled();
    await user.type(editor, " more");
    expect(reset).toBeEnabled();
    await user.click(reset);
    expect((editor as HTMLTextAreaElement).value).toBe(server.state.prompts.starter);
    await user.clear(editor);
    expect(screen.getByText("This prompt is off.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.state.prompts.starter).toBe("");
    expect(server.state.prompts.workspace).not.toBe("");
  });

  it("lists the four templates", async () => {
    renderWithServer(<PromptsDialog onClose={() => undefined} />, new FakeServer());
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Workspace subfolder",
      "Port hint",
      "Starter",
      "Worktree",
    ]);
  });
});

describe("SSH remote dialog", () => {
  it("validates the name and target", () => {
    expect(remoteProblems("", "bad target", null, [])).toEqual([
      "Type a name.",
      "The SSH target must look like user@host or user@host:port.",
    ]);
    expect(remoteProblems("db", "u@h", null, ["db"])).toEqual(["A remote named db exists."]);
    expect(remoteProblems("db", "u@h", "db", ["db"])).toEqual([]);
  });

  it("saves a remote with its forwards", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const onClose = vi.fn();
    renderWithServer(<SshRemoteDialog remote={null} taken={[]} onClose={onClose} />, server);
    await user.type(screen.getByLabelText("Name"), "db");
    await user.type(screen.getByLabelText("SSH target"), "user@db.example.com:2222");
    await user.click(screen.getByRole("button", { name: "Add forward" }));
    await user.type(screen.getByLabelText("bindPort 1"), "5432");
    await user.type(screen.getByLabelText("destPort 1"), "5432");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.state.sshRemotes[0]).toEqual({
      name: "db",
      host: "user@db.example.com:2222",
      forwards: [
        {
          direction: "L",
          bindAddress: "localhost",
          bindPort: 5432,
          destHost: "localhost",
          destPort: 5432,
        },
      ],
    });
  });

  it("offers ssh-copy-id when the key is refused", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ autoFinishJobs: false });
    server.on("sshRemotes.test", () => ({
      ok: false,
      authFailed: true,
      output: "Permission denied (publickey).",
    }));
    renderWithServer(
      <SshRemoteDialog remote={null} taken={[]} onClose={() => undefined} />,
      server,
    );
    await user.type(screen.getByLabelText("Name"), "db");
    await user.type(screen.getByLabelText("SSH target"), "user@db");
    await user.click(screen.getByRole("button", { name: "Test Connection" }));
    await user.click(await screen.findByRole("button", { name: "Copy Key" }));
    expect(await screen.findByText("Running: ssh-copy-id db")).toBeInTheDocument();
    expect(server.callsTo("sshRemotes.put")).toHaveLength(1);
    expect(server.callsTo("sshRemotes.test")[0]?.body).toEqual({
      name: "db",
      host: "user@db",
      forwards: [],
    });
  });
});

describe("MountsDialog", () => {
  it("rejects relative paths and saves parsed mounts", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => null);
    renderWithServer(
      <MountsDialog
        title="Global Mounts"
        intro="x"
        mounts={[]}
        onSave={onSave}
        onCancel={() => undefined}
      />,
      new FakeServer(),
    );
    const box = screen.getByLabelText(/Mounts, one/);
    await user.type(box, "data");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("absolute");
    await user.clear(box);
    await user.type(box, "/srv/data:/data{enter}/opt/tools");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        mounts: [
          { host: "/srv/data", container: "/data" },
          { host: "/opt/tools", container: "/opt/tools" },
        ],
      }),
    );
  });
});

describe("SetupWizard and jobs", () => {
  it("lists the checks and runs a fix as a job", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ autoFinishJobs: false });
    renderWithServer(<SetupWizard onClose={() => undefined} />, server);
    expect(await screen.findByText("No key at ~/.ssh/id_ed25519.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rebuild Image" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByText("Running: fix ssh_key")).toBeInTheDocument();
    server.finishJob("job-1", 0);
    expect(await screen.findByText("Finished.", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("saves the default directory on Done", async () => {
    const user = userEvent.setup();
    const server = new FakeServer({ settings: { setupCompleted: false } });
    const onClose = vi.fn();
    renderWithServer(<SetupWizard onClose={onClose} />, server);
    await screen.findByText("Docker reachable");
    await user.type(screen.getByLabelText("Default directory for New Box"), "/home/u/projects");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(server.state.settings).toMatchObject({
      setupCompleted: true,
      defaultTargetDir: "/home/u/projects",
    });
  });

  it("words the job states like the Qt dialog", () => {
    const base: Job = {
      id: "j",
      kind: "image_build",
      boxId: null,
      command: "docker build",
      status: "running",
      exitCode: null,
      error: null,
      result: null,
      startedAt: "2026-10-28T09:00:00Z",
      finishedAt: null,
    };
    expect(jobLabel(base, "x")).toBe("Running: docker build");
    expect(jobLabel({ ...base, status: "finished", exitCode: 0 }, "x")).toBe("Finished.");
    expect(jobLabel({ ...base, status: "failed", exitCode: 2 }, "x")).toBe("Finished (exit 2).");
    expect(
      jobLabel(
        { ...base, status: "failed", error: { code: "conflict", message: "no docker" } },
        "x",
      ),
    ).toBe("Failed to start docker build: no docker");
  });

  it("polls a job until it leaves running", async () => {
    let n = 0;
    const job = await waitForJob(
      async () => ({ status: ++n < 3 ? "running" : "finished" }) as Job,
      { intervalMs: 1 },
    );
    expect(job.status).toBe("finished");
    expect(n).toBe(3);
  });

  it("shows the job result when it finishes", async () => {
    const server = new FakeServer({ autoFinishJobs: false });
    const job = server.startJob("convert_to_worktree", "convert x", null, () => ({ ok: 1 }));
    const onDone = vi.fn();
    renderWithServer(
      <JobDialog
        title="Convert"
        job={job}
        onClose={() => undefined}
        onDone={onDone}
        renderResult={() => <span>report here</span>}
      />,
      server,
    );
    expect(screen.getByText("Running: convert x")).toBeInTheDocument();
    server.finishJob(job.id, 0);
    expect(await screen.findByText("report here", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
