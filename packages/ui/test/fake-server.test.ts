import { describe, expect, it } from "vitest";
import { ApiClient } from "../src/core";
import { FakeServer, makeBoxView } from "../src/testing";

describe("FakeServer", () => {
  it("answers every default route within the contract", async () => {
    const server = new FakeServer({
      boxes: [
        makeBoxView({
          box: {
            id: "claude-agent-a",
            targetDir: "/w/a",
            sessionUuid: "11111111-1111-4111-8111-111111111111",
          },
        }),
        makeBoxView({ box: { id: "claude-agent-b", targetDir: "/w/a" }, status: "running" }),
      ],
    });
    const c = new ApiClient({ fetch: server.fetch });
    await c.call("projects.list", {});
    await c.call("settings.get", {});
    await c.call("prompts.get", {});
    await c.call("setup.get", {});
    await c.call("image.status", {});
    await c.call("updates.check", {});
    await c.call("models.list", { query: { dir: "/w/a" } });
    await c.call("sshRemotes.list", {});
    const job = await c.call("boxes.create", {
      body: { targetDir: "/w/a", layout: "root", conversationName: "Fix it" },
    });
    await Promise.resolve();
    const done = await c.call("jobs.get", { params: { jobId: job.id } });
    expect(done.status).toBe("finished");
    await expect(
      c.call("boxes.create", {
        body: {
          targetDir: "/w/a",
          layout: "root",
          conversation: { mode: "adopt", sessionUuid: "11111111-1111-4111-8111-111111111111" },
        },
      }),
    ).rejects.toMatchObject({ code: "session_tracked", details: { holders: ["claude-agent-a"] } });
    await expect(
      c.call("boxes.purge", { params: { boxId: "claude-agent-a" } }),
    ).rejects.toMatchObject({ code: "box_running" });
    expect(server.contractViolations).toEqual([]);
  });

  it("answers the C2 routes within the contract", async () => {
    const view = makeBoxView({
      box: { id: "claude-agent-a", targetDir: "/w/a", workspace: "Mail" },
    });
    const server = new FakeServer({ boxes: [view] });
    const c = new ApiClient({ fetch: server.fetch });
    const preview = await c.call("boxes.purge", {
      params: { boxId: "claude-agent-a" },
      body: { dryRun: true },
    });
    expect(preview).toMatchObject({ dryRun: true, removedRecords: ["claude-agent-a"] });
    expect(server.state.boxes).toHaveLength(1);
    const plan = await c.call("boxes.convertToWorktree.plan", {
      params: { boxId: "claude-agent-a" },
    });
    expect(plan.report).toContain("/w/a/.worktrees/Mail");
    server.state.staleProjects.push(view.box.projectId);
    await expect(
      c.call("boxes.start", { params: { boxId: "claude-agent-a" } }),
    ).rejects.toMatchObject({ code: "stale_mounts" });
    const started = await c.call("boxes.start", {
      params: { boxId: "claude-agent-a" },
      body: { force: true },
    });
    expect(started.status).toBe("running");
    const home = await c.call("fs.dirs");
    expect(home).toMatchObject({ path: "/home/user", parent: "/home" });
    expect(home.entries.map((e) => e.path)).toEqual(["/home/user/src", "/home/user/work"]);
    await expect(c.call("fs.dirs", { query: { path: "/nope" } })).rejects.toMatchObject({
      code: "not_found",
    });
    const remote = { name: "db", host: "u@db" };
    expect((await c.call("sshRemotes.test", { body: remote })).ok).toBe(true);
    await expect(c.call("sshRemotes.testSaved", { params: { name: "db" } })).rejects.toMatchObject({
      code: "not_found",
    });
    const repos = await c.call("projects.repos.list", {
      params: { projectId: view.box.projectId },
    });
    expect(repos.repos[0]?.path).toBe("/w/a");
    await c.call("projects.repos.refs", {
      params: { projectId: view.box.projectId },
      query: { repo: "/w/a" },
    });
    await c.call("runs.list");
    await c.call("usage.samples");
    const patched = await c.call("settings.patch", {
      body: {
        vendorDefaults: { codex: { model: "gpt-6" } },
        notifications: { readyToPush: false },
      },
    });
    expect(patched.vendorDefaults.copilot.model).toBe("auto");
    expect(patched.notifications).toMatchObject({ readyToPush: false, runFinished: true });
    const cleared = await c.call("settings.patch", {
      body: { vendorDefaults: { codex: { model: null } } },
    });
    expect(cleared.vendorDefaults.codex).toEqual({});
    expect(server.contractViolations).toEqual([]);
  });

  it("answers 400 to a body the schema rejects", async () => {
    const server = new FakeServer();
    const res = await server.fetch("http://x/api/v1/boxes", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
