#!/usr/bin/env node
// Host smoke test for the server core against real Docker. Run it on the
// host, never in a box. See README.md in this directory.
//
// It uses a temporary data directory (database, keeper state, and sessions
// directories) and a temporary project directory, builds a throwaway image on
// top of the base image that carries a test engine version, and removes
// everything it made unless you pass --keep.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildLaunchSpec,
  createServerCore,
  defaultHostEnv,
  homePaths,
  liveSessions,
  projectsLinkMounts,
  sessionStartCmd,
  toDockerRunArgs,
} from "../../dist/core.js";

const args = new Set(process.argv.slice(2));
const baseImage = process.argv.find((a) => a.startsWith("--image="))?.slice(8) ?? "aio-agent";
const keep = args.has("--keep");
const withClaude = args.has("--claude");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aio-host-")));
const env = { ...defaultHostEnv(), dataDir: path.join(tmp, "data") };
const { stateDir } = homePaths(env);
const root = path.join(tmp, "project");
fs.mkdirSync(root);
const engineVersion = `hosttest-${Date.now()}`;
const testImage = "aio-hosttest";
const core = createServerCore({
  engineVersion,
  env,
  graceSec: 5,
});

function step(name) {
  console.log(`\n== ${name}`);
}

async function waitFor(what, fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(250);
  }
}

async function waitForContainerGone(name, timeoutMs = 20000) {
  await waitFor(
    `${name} to exit`,
    async () => (await core.docker.inspectContainer(name)) === null,
    timeoutMs,
  );
}

let container;
try {
  step(`Build ${testImage} from ${baseImage}`);
  const ctx = path.join(tmp, "image");
  fs.mkdirSync(ctx);
  fs.writeFileSync(
    path.join(ctx, "Dockerfile"),
    `FROM ${baseImage}\nUSER root\nRUN echo ${engineVersion} > /etc/aio-engine-version\nLABEL aio.engine-version=${engineVersion}\n`,
  );
  // The build goes through the docker CLI, as the server's own image build
  // does; everything else goes through the API client.
  const built = spawnSync("docker", ["build", "-t", testImage, ctx], { stdio: "inherit" });
  assert.equal(
    built.status,
    0,
    built.error
      ? `docker build didn't start: ${built.error.message}`
      : `docker build failed with ${built.signal ?? `exit code ${built.status}`}`,
  );
  const visible = await core.docker.docker
    ?.getImage(testImage)
    .inspect()
    .then(() => true)
    .catch(() => false);
  assert.ok(
    visible,
    `The docker CLI built ${testImage}, but the API client can't see it. The CLI's context and the API client's socket reach different daemons; set DOCKER_HOST to point both at the same one.`,
  );
  core.settings.patch({ engineImage: testImage });
  const status = await core.image.status();
  console.log(status);
  assert.equal(status.engineMatches, true);

  step("Create the project and print the launch line");
  const project = core.projects.create({ root, name: "Host smoke" });
  container = core.projects.containerName(project);
  const preview = buildLaunchSpec(
    env,
    {
      container,
      projectId: project.id,
      root,
      mounts: [],
      globalMounts: [],
      tcpMaps: [],
      image: testImage,
      engine: { hostPort: 1, token: "x", version: engineVersion },
      secretNames: [],
    },
    { projectsLinkMounts: projectsLinkMounts(env), hasGitconfig: false },
  );
  console.log(["docker", ...toDockerRunArgs(preview)].join(" "));

  step("Start the project container");
  const ensured = await core.projects.ensureContainer(project.id, {
    extraEnv: { AIO_HOSTTEST: "1" },
  });
  assert.equal(ensured.created, true);
  const inspect = await core.docker.inspectContainer(container);
  const endpoint = core.projects.engineEndpoint(project.id);
  console.log({
    binds: inspect.binds,
    ports: inspect.portBindings,
    endpoint: { ...endpoint, token: "***" },
  });
  assert.equal(inspect.running, true);
  assert.deepEqual(inspect.portBindings["20411/tcp"], [
    { hostIp: "127.0.0.1", hostPort: String(endpoint.hostPort) },
  ]);
  assert.ok(inspect.env.includes("IS_SANDBOX=1"));
  assert.ok(inspect.env.includes("AIO_STATE_DIR=/run/aio"));
  assert.ok(inspect.env.includes("AIO_HOSTTEST=1"));
  assert.ok(inspect.binds.includes(`${root}:${root}`));

  step("The keeper writes its state file");
  await waitFor("the keeper state file", () =>
    fs.existsSync(path.join(stateDir, container, "sessions")),
  );

  step("Start a tmux session with the session start script");
  const ok = await core.docker.exec(container, {
    cmd: sessionStartCmd("hosttest", root, "sleep 300"),
    user: env.user,
    timeoutMs: 60000,
  });
  assert.equal(ok.exitCode, 0, ok.stderr);
  await waitFor("the session in the state file", () =>
    liveSessions(env, container).includes("hosttest"),
  );
  const again = await core.docker.exec(container, {
    cmd: sessionStartCmd("hosttest", root, "sleep 300"),
    user: env.user,
    timeoutMs: 60000,
  });
  assert.equal(again.exitCode, 3);
  const dies = await core.docker.exec(container, {
    cmd: sessionStartCmd("dies", root, "false"),
    user: env.user,
    timeoutMs: 60000,
  });
  assert.equal(dies.exitCode, 2);

  step("Sample stats twice");
  // The monitor samples every aio-agent-* container on the host; keep
  // only this test's own.
  const stats = [];
  core.events.on("container.stats", (e) => {
    if (e.container === container) stats.push(e);
  });
  await core.monitor.poll({ sampleStats: true });
  await sleep(1000);
  await core.monitor.poll({ sampleStats: true });
  console.log(stats.at(-1));
  assert.ok(stats.length >= 1, `no stats sample for ${container}`);

  step("Kill the session; the idle container leaves after its grace period");
  const kill = await core.docker.exec(container, {
    cmd: ["tmux", "kill-session", "-t", "=hosttest"],
    user: env.user,
  });
  assert.equal(kill.exitCode, 0, kill.stderr);
  if (!keep || withClaude) {
    await waitForContainerGone(container);
    console.log("Container removed itself.");
  }

  if (withClaude) {
    // The container from the earlier steps carried AIO_HOSTTEST, which
    // boxes.create() would count as a stale secret. It is gone by now, so
    // create() starts a new one with the project's own settings.
    step("Create, stop, and purge a real box that runs Claude");
    const box = await core.boxes.create({
      targetDir: root,
      layout: "root",
      conversationName: "host smoke",
    });
    const status = () => core.boxes.status(core.boxes.get(box.id));
    await waitFor("the claude session", () => status() === "running");
    await sleep(5000);
    await core.boxes.stop(box.id);
    const stoppedAt = Date.now();
    // purge() refuses with box_running while the box is still stopping.
    await waitFor("the box to stop", () => status() === "stopped", 15000);
    console.log(`Box stopped after ${Date.now() - stoppedAt} ms.`);
    console.log(await core.boxes.purge(box.id));
    if (!keep) {
      await waitForContainerGone(container);
      console.log("Container removed itself.");
    }
  }
  console.log("\nHost smoke test passed.");
} finally {
  if (!keep) {
    if (container)
      await core.docker.removeContainer(container, { force: true }).catch(() => undefined);
    await core.docker.docker
      ?.getImage(testImage)
      .remove()
      .catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log(`Kept ${tmp}, the container ${container}, and the image ${testImage}.`);
  }
  core.close();
}
