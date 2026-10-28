import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Launcher } from "../src/screens/Launcher.js";
import { BOX, PROJECT, boxView, lastRun, project } from "./helpers/data.js";
import { MockError } from "./helpers/mockServer.js";
import { renderWithStore } from "./helpers/render.js";

const preview = {
  baseSha: "4e1c2a9b7d3f",
  tipSha: "a1b2c3d4e5f6",
  diffBaseSha: "4e1c2a9b7d3f",
  changedLines: 312,
  dirty: true,
  groups: [
    { id: "g1", files: ["src/mail/send.ts"], kind: "major", changedLines: 250, riskPath: true, hunks: [] },
    { id: "g2", files: ["README.md"], kind: "minor", changedLines: 62, riskPath: false, hunks: [] },
  ],
};

function handlers() {
  return {
    "projects.list": () => ({ projects: [project] }),
    "boxes.get": () => boxView(),
    "runs.preview": () => preview,
    "runs.create": () => lastRun(),
  };
}

describe("Launcher", () => {
  it("prefills from the deep link box and starts a run", async () => {
    const { server } = renderWithStore(<Launcher prefill={{ project: null, box: BOX }} />, handlers());
    await waitFor(() => expect(screen.getByLabelText("Tip branch")).toHaveValue("claude/Emails_not_sending"));
    expect(screen.getByLabelText("Container")).toHaveValue(PROJECT);
    await waitFor(() =>
      expect(screen.getByLabelText(/^Repository/)).toHaveValue("/home/user/src/example-app/.worktrees/Emails_not_sending"),
    );
    expect(screen.getByText(/showing the project's primary repository/)).toBeInTheDocument();

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

  it("uses the server's repositories and refs when it has them", async () => {
    const { server } = renderWithStore(<Launcher prefill={{ project: PROJECT, box: null }} />, handlers());
    server.raw[`GET /api/v1/projects/${PROJECT}/repos`] = () => ({
      repos: [{ path: "/home/user/src/example-app", name: "example-app", currentBranch: "feature/x", headSha: "abcdef1", dirty: false }],
    });
    server.raw[`GET /api/v1/projects/${PROJECT}/repos/refs`] = () => ({
      localBranches: ["feature/x", "main"],
      remoteBranches: ["origin/main", "origin/feature/shared"],
      tags: ["v1.0.0"],
      recentCommits: [{ sha: "abcdef1", subject: "Fix it", author: "dev", time: "2026-10-28T09:00:00.000Z" }],
      pullRequests: [{ number: 7, title: "Feature X", headRef: "feature/x", baseRef: "feature/shared", url: "https://github.com/o/r/pull/7" }],
    });
    await waitFor(() => expect(screen.getByLabelText("Tip branch")).toHaveValue("feature/x"));
    await screen.findByRole("option", { name: "v1.0.0" });
    fireEvent.change(screen.getByLabelText("Base"), { target: { value: "origin/feature/shared" } });
    fireEvent.click(screen.getByRole("radio", { name: /Post-push/ }));
    fireEvent.change(screen.getByLabelText(/^Pull request number/), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(server.callsTo("runs.create")).toHaveLength(1));
    expect(server.callsTo("runs.create")[0]!.body).toMatchObject({ base: "origin/feature/shared", pipeline: "post-push", prNumber: 7 });
  });

  it("lists form problems and server refusals", async () => {
    const h = {
      ...handlers(),
      "runs.create": () => {
        throw new MockError(409, "dirty_tree", "The working tree has uncommitted changes.");
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
});
