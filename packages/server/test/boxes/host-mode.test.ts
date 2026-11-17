import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeHarness } from "./harness.js";

describe("retired host accounts mode", () => {
  it("keeps stored host settings readable but refuses box creation without touching vendor folders", async () => {
    const h = makeHarness();
    h.core.settings.patch({ accountsMode: "host" });
    expect(h.core.settings.get().accountsMode).toBe("host");
    await expect(
      h.core.boxes.create({ targetDir: h.dir("project"), layout: "root", start: false }),
    ).rejects.toThrow(/set up accounts/i);
    expect(await h.docker.listContainers({ all: true })).toEqual([]);
  });
});

it("refuses legacy account links into host vendor folders until the owner relinks", async () => {
  const h = makeHarness();
  const hostSkills = h.dir(".claude", "skills");
  const account = path.join(h.home, ".ai-orchestrator", "accounts", "claude", "fixture");
  fs.symlinkSync(hostSkills, path.join(account, "skills"));
  await expect(h.core.boxes.create({ targetDir: h.dir("work"), layout: "root" })).rejects.toThrow(
    /relink/i,
  );
  expect(await h.docker.listContainers({ all: true })).toEqual([]);
});

it("refuses every actual session start path while stored settings remain in host mode", async () => {
  const h = makeHarness();
  const stopped = await h.core.boxes.create({
    targetDir: h.dir("stopped"),
    layout: "root",
    start: false,
  });
  const running = await h.core.boxes.create({ targetDir: h.dir("running"), layout: "root" });
  h.core.settings.patch({ accountsMode: "host" });
  await expect(
    h.core.boxes.validateCreate({ targetDir: h.dir("new"), layout: "root" }),
  ).rejects.toThrow(/set up accounts/i);
  await expect(h.core.boxes.start(stopped.id)).rejects.toThrow(/set up accounts/i);
  await expect(h.core.boxes.restart(running.id)).rejects.toThrow(/set up accounts/i);
  await expect(h.core.boxes.startSideSession(running.id, "codex")).rejects.toThrow(
    /set up accounts/i,
  );
  await expect(h.core.boxes.restartAll()).rejects.toThrow(/set up accounts/i);
  await expect(h.core.boxes.restartProjectContainer(running.projectId)).rejects.toThrow(
    /set up accounts/i,
  );
  const bulk = await h.core.boxes.startAll(false);
  expect(bulk.failed[0]?.error.message).toMatch(/set up accounts/i);
  await expect(h.core.projects.ensureContainer(running.projectId)).rejects.toThrow(
    /set up accounts/i,
  );
  expect(h.core.boxes.view(h.core.boxes.get(running.id)).status).toBe("running");
});
