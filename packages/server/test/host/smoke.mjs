#!/usr/bin/env node
// Host smoke test for the server core against real Docker. Run it on the
// host, never in a box. See README.md in this directory.
//
// It uses a temporary database and a temporary project directory, builds a
// throwaway image on top of the base image that carries a test engine
// version, and removes everything it made unless you pass --keep.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildLaunchSpec,
  createCore,
  defaultHostEnv,
  liveSessions,
  projectsSymlinkTarget,
  sessionStartCmd,
  toDockerRunArgs,
} from "../../dist/core.js";

const args = new Set(process.argv.slice(2));
const baseImage = process.argv.find((a) => a.startsWith("--image="))?.slice(8) ?? "claude-code";
const keep = args.has("--keep");
const withClaude = args.has("--claude");

const env = defaultHostEnv();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-host-")));
const root = path.join(tmp, "project");
fs.mkdirSync(root);
const engineVersion = `hosttest-${Date.now()}`;
const testImage = "agentbox-hosttest";
const core = createCore({ engineVersion, env, dbPath: path.join(tmp, "agentbox.db"), graceSec: 5 });

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

let container;
try {
  step(`Build ${testImage} from ${baseImage}`);
  const ctx = path.join(tmp, "image");
  fs.mkdirSync(ctx);
  fs.writeFileSync(
    path.join(ctx, "Dockerfile"),
    `FROM ${baseImage}\nUSER root\nRUN echo ${engineVersion} > /etc/agentbox-engine-version\nLABEL agentbox.engine-version=${engineVersion}\n`,
  );
  const built = await core.docker.buildImage(
    { context: ctx, tag: testImage, buildArgs: {}, noCache: false, pull: false },
    (line) => process.stdout.write(line),
  );
  assert.equal(built.ok, true, built.error);
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
      extraEnv: {},
    },
    { projectsSymlinkTarget: projectsSymlinkTarget(env), hasGitconfig: false },
  );
  console.log(["docker", ...toDockerRunArgs(preview)].join(" "));

  step("Start the project container");
  const ensured = await core.projects.ensureContainer(project.id, {
    extraEnv: { AGENTBOX_HOSTTEST: "1" },
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
  assert.ok(inspect.env.includes("AGENTBOX_HOSTTEST=1"));
  assert.ok(inspect.binds.includes(`${root}:${root}`));

  step("The keeper writes its state file");
  await waitFor("the keeper state file", () =>
    fs.existsSync(path.join(env.home, ".claude-box/state", container, "sessions")),
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
  const stats = [];
  core.events.on("container.stats", (e) => stats.push(e));
  await core.monitor.poll({ sampleStats: true });
  await sleep(1000);
  await core.monitor.poll({ sampleStats: true });
  console.log(stats.at(-1));
  assert.ok(stats.length >= 1);

  if (withClaude) {
    step("Create, stop, and purge a real Claude box");
    const box = await core.boxes.create({
      targetDir: root,
      layout: "root",
      conversationName: "host smoke",
    });
    await waitFor(
      "the claude session",
      () => core.boxes.status(core.boxes.get(box.id)) === "running",
    );
    await sleep(5000);
    await core.boxes.stop(box.id);
    const purged = await core.boxes.purge(box.id);
    console.log(purged);
  }

  step("Kill the session; the idle container leaves after its grace period");
  const kill = await core.docker.exec(container, {
    cmd: ["tmux", "kill-session", "-t", "=hosttest"],
    user: env.user,
  });
  assert.equal(kill.exitCode, 0, kill.stderr);
  if (!keep) {
    await waitFor(
      "the container to exit",
      async () => (await core.docker.inspectContainer(container)) === null,
      20000,
    );
    console.log("Container removed itself.");
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
    if (container)
      fs.rmSync(path.join(env.home, ".claude-box/state", container), {
        recursive: true,
        force: true,
      });
    if (container)
      fs.rmSync(path.join(env.home, ".claude-box/sessions", container), {
        recursive: true,
        force: true,
      });
  } else {
    console.log(`Kept ${tmp}, the container ${container}, and the image ${testImage}.`);
  }
  core.close();
}
