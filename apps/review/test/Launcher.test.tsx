import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Launcher } from "../src/screens/Launcher.js";
import { BOX, PROJECT, boxView, lastRun, project } from "./helpers/data.js";
import { FakeApiError } from "@agentbox/ui/testing";
import { renderWithStore } from "./helpers/render.js";
import { StoreProvider } from "../src/state/store.js";

const preview = {
  baseSha: "4e1c2a9b7d3f",
  tipSha: "a1b2c3d4e5f6",
  diffBaseSha: "4e1c2a9b7d3f",
  changedLines: 312,
  dirty: true,
  groups: [
    {
      id: "g1",
      files: ["src/mail/send.ts"],
      kind: "major",
      changedLines: 250,
      riskPath: true,
      hunks: [],
    },
    { id: "g2", files: ["README.md"], kind: "minor", changedLines: 62, riskPath: false, hunks: [] },
  ],
};

function handlers() {
  return {
    "projects.list": () => ({ projects: [project] }),
    // The engine isn't up: the launcher falls back to the primary repository.
    "projects.repos.list": () => {
      throw new FakeApiError("not_found", "The project's engine isn't running.", 404);
    },
    "boxes.get": () => boxView(),
    "runs.preview": () => preview,
    "runs.create": () => lastRun(),
  };
}

describe("Launcher", () => {
  it("prefills from the deep link box and starts a run", async () => {
    const { server } = renderWithStore(
      <Launcher prefill={{ project: null, box: BOX }} />,
      handlers(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Tip branch")).toHaveValue("claude/Emails_not_sending"),
    );
    expect(screen.getByLabelText("Container")).toHaveValue(PROJECT);
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue(
        "/home/user/src/example-app/.worktrees/Emails_not_sending",
      ),
    );
    // The repository value comes from the box, so it can settle before the
    // failed repository listing does. Wait for the fallback hint itself.
    expect(await screen.findByText(/showing the project's primary repository/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview groups" }));
    expect(await screen.findByText(/2 groups, 312 changed lines/)).toBeInTheDocument();
    expect(screen.getByText(/The working tree has uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByText("major (risk path)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Exact base/ }));
    fireEvent.change(screen.getByLabelText("Profile"), { target: { value: "fast" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(server.callsTo("runs.create")).toHaveLength(1));
    expect(server.callsTo("runs.create")[0]!.body).toMatchObject({
      projectId: PROJECT,
      boxId: BOX,
      base: "origin/main",
      tip: "claude/Emails_not_sending",
      mergeBase: false,
      exactBase: true,
      profile: "fast",
      pipeline: "pre-push",
    });
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${lastRun().id}`));
  });

  it("starts one run when the form is submitted twice", async () => {
    const { server } = renderWithStore(
      <Launcher prefill={{ project: null, box: BOX }} />,
      handlers(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue(
        "/home/user/src/example-app/.worktrees/Emails_not_sending",
      ),
    );
    const form = screen.getByRole("button", { name: "Start" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${lastRun().id}`));
    expect(server.callsTo("runs.create")).toHaveLength(1);
  });

  // Finding 24: the form used to re-enable before the route change.
  it("keeps the form disabled after a start succeeds", async () => {
    const { server } = renderWithStore(
      <Launcher prefill={{ project: null, box: BOX }} />,
      handlers(),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue(
        "/home/user/src/example-app/.worktrees/Emails_not_sending",
      ),
    );
    const form = screen.getByRole("button", { name: "Start" }).closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${lastRun().id}`));
    // This test has no router, so the launcher stays mounted.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 10));
    expect(server.callsTo("runs.create")).toHaveLength(1);
  });

  it("enables the form again after a start fails", async () => {
    renderWithStore(<Launcher prefill={{ project: null, box: BOX }} />, {
      ...handlers(),
      "runs.create": () => {
        throw new FakeApiError("conflict", "A run is already active for this box.", 409);
      },
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue(
        "/home/user/src/example-app/.worktrees/Emails_not_sending",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText(/already active/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  // Finding 25: a start during a preview used to vanish without a word.
  it("says why a start during a preview does nothing", async () => {
    let release: () => void = () => undefined;
    const { server } = renderWithStore(<Launcher prefill={{ project: null, box: BOX }} />, {
      ...handlers(),
      "runs.preview": () =>
        new Promise((resolve) => {
          release = () => resolve(preview);
        }),
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue(
        "/home/user/src/example-app/.worktrees/Emails_not_sending",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview groups" }));
    fireEvent.submit(screen.getByRole("button", { name: "Start" }).closest("form")!);
    expect(await screen.findByText(/The preview is still resolving/)).toBeInTheDocument();
    release();
    expect(await screen.findByText(/2 groups, 312 changed lines/)).toBeInTheDocument();
    expect(server.callsTo("runs.create")).toHaveLength(0);
  });

  // Finding 26: disabling the fieldset used to leave focus on the page body.
  it("gives focus back to the field that had it after a preview", async () => {
    let release: () => void = () => undefined;
    renderWithStore(<Launcher prefill={{ project: null, box: BOX }} />, {
      ...handlers(),
      "runs.preview": () =>
        new Promise((resolve) => {
          release = () => resolve(preview);
        }),
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue(
        "/home/user/src/example-app/.worktrees/Emails_not_sending",
      ),
    );
    const roundCap = screen.getByLabelText("Round cap");
    act(() => roundCap.focus());
    fireEvent.click(screen.getByRole("button", { name: "Preview groups" }));
    await waitFor(() => expect(roundCap).toBeDisabled());
    // A browser moves focus to the body when the focused field becomes
    // disabled; jsdom doesn't, so the test does.
    act(() => {
      const tmp = document.createElement("button");
      document.body.append(tmp);
      tmp.focus();
      tmp.remove();
    });
    release();
    expect(await screen.findByText(/2 groups, 312 changed lines/)).toBeInTheDocument();
    expect(roundCap).toHaveFocus();
  });

  it("uses the server's repositories and refs when it has them", async () => {
    const { server } = renderWithStore(
      <Launcher prefill={{ project: PROJECT, box: null }} />,
      handlers(),
    );
    server.on("projects.repos.list", () => ({
      repos: [
        {
          path: "/home/user/src/example-app",
          name: "example-app",
          currentBranch: "feature/x",
          headSha: "abcdef1",
          dirty: false,
        },
      ],
    }));
    server.on("projects.repos.refs", () => ({
      localBranches: ["feature/x", "main"],
      remoteBranches: ["origin/main", "origin/feature/shared"],
      tags: ["v1.0.0"],
      recentCommits: [
        { sha: "abcdef1", subject: "Fix it", author: "dev", time: "2026-10-28T09:00:00.000Z" },
      ],
      pullRequests: [
        {
          number: 7,
          title: "Feature X",
          headRef: "feature/x",
          baseRef: "feature/shared",
          url: "https://github.com/o/r/pull/7",
        },
      ],
    }));
    await waitFor(() => expect(screen.getByLabelText("Tip branch")).toHaveValue("feature/x"));
    await screen.findByRole("option", { name: "v1.0.0" });
    fireEvent.change(screen.getByLabelText("Base"), { target: { value: "origin/feature/shared" } });
    fireEvent.click(screen.getByRole("radio", { name: /Post-push/ }));
    fireEvent.change(screen.getByLabelText(/^Pull request number/), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(server.callsTo("runs.create")).toHaveLength(1));
    expect(server.callsTo("runs.create")[0]!.body).toMatchObject({
      base: "origin/feature/shared",
      pipeline: "post-push",
      prNumber: 7,
    });
  });

  it("lists form problems and server refusals", async () => {
    const h = {
      ...handlers(),
      "runs.create": () => {
        throw new FakeApiError("dirty_tree", "The working tree has uncommitted changes.", 409);
      },
    };
    renderWithStore(<Launcher prefill={{ project: null, box: null }} />, h);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Select a container.")).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Container"), { target: { value: PROJECT } });
    await waitFor(() => expect(screen.getByLabelText(/^Repository/)).not.toHaveValue(""));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText(/uncommitted changes\./)).toBeInTheDocument();
  });

  it("follows a later project-only deep link while it stays open", async () => {
    const OTHER = "other-app-9f8e7d6c";
    const other = {
      ...project,
      project: {
        ...project.project,
        id: OTHER,
        name: "other-app",
        root: "/home/user/src/other-app",
        primaryRepo: "/home/user/src/other-app",
      },
    };
    const r = renderWithStore(<Launcher prefill={{ project: PROJECT, box: null }} />, {
      ...handlers(),
      "projects.list": () => ({ projects: [project, other] }),
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue("/home/user/src/example-app"),
    );
    r.rerender(
      <StoreProvider store={r.store}>
        <Launcher prefill={{ project: OTHER, box: null }} />
      </StoreProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Container")).toHaveValue(OTHER));
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue("/home/user/src/other-app"),
    );
  });
});
