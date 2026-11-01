#!/usr/bin/env node
// Host check for finding 1 of the server review: a box still starts when its
// project container goes away between ensureContainer() and the session exec.
// Run it on the host, never in a box. See README.md in this directory.
//
// The first session-start exec force-removes the project container just
// before it runs, so the real dockerode client gets the 404 that a keeper
// leaving at the end of its grace period produces. The script uses a
// temporary data directory and project, starts a real box that runs Claude, and
// removes everything it made.
//
// Usage: node packages/server/test/host/start-retry.mjs [--image=IMAGE]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServerCore, defaultHostEnv } from "../../dist/core.js";
import { serverVersion } from "../../dist/main.js";

const image = process.argv.find((a) => a.startsWith("--image="))?.slice(8) ?? "aio-agent";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aio-retry-")));
const env = { ...defaultHostEnv(), dataDir: path.join(tmp, "data") };
const root = path.join(tmp, "project");
fs.mkdirSync(root);
// The image's engine version must match, so expect the one this checkout builds.
const core = createServerCore({ engineVersion: serverVersion(), env, graceSec: 5 });

async function waitFor(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(100);
  }
}

let container;
try {
  core.settings.patch({ engineImage: image });
  const project = core.projects.create({ root, name: "Start retry" });
  container = core.projects.containerName(project);
  assert.match(container, /^aio-agent-proj-/);

  const realExec = core.docker.exec.bind(core.docker);
  let removed = false;
  core.docker.exec = async (name, options) => {
    const isStart = options.cmd.some((c) => String(c).includes("start-session"));
    if (isStart && !removed && name === container) {
      removed = true;
      console.log(`Removing ${name} before the first session-start exec.`);
      await core.docker.removeContainer(name, { force: true });
    }
    return realExec(name, options);
  };

  const box = await core.boxes.create({
    targetDir: root,
    layout: "root",
    conversationName: "start retry",
  });
  const status = () => core.boxes.status(core.boxes.get(box.id));
  assert.equal(removed, true, "the session-start exec was never intercepted");
  const inspect = await core.docker.inspectContainer(container);
  assert.equal(inspect?.running, true, "no new container is running");
  console.log(`Box ${box.id} started; status ${status()}.`);

  await sleep(3000);
  await core.boxes.stop(box.id);
  const stoppedAt = Date.now();
  console.log(`Status right after stop(): ${status()}.`);
  // purge() refuses with box_running while the box is still stopping.
  await waitFor("the box to stop", () => status() === "stopped", 15000);
  console.log(`Status stopped after ${Date.now() - stoppedAt} ms.`);
  console.log(await core.boxes.purge(box.id));
  console.log("\nStart retry check passed.");
} finally {
  if (container)
    await core.docker.removeContainer(container, { force: true }).catch(() => undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
  core.close();
}
