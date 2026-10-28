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

  it("answers 400 to a body the schema rejects", async () => {
    const server = new FakeServer();
    const res = await server.fetch("http://x/api/v1/boxes", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
