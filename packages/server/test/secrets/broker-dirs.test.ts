import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDocker } from "../../src/docker/memory.js";
import type { ContainerCreateSpec } from "../../src/docker/types.js";
import { brokerDirName } from "../../src/records/env.js";
import { removeUnusedBrokerDirs } from "../../src/secrets/broker-dirs.js";
import { tempDir } from "../tmp.js";

function addContainer(docker: MemoryDocker, name: string, binds: string[] = []): void {
  docker.containers.set(name, {
    id: `id-${name}`,
    spec: { name, binds, env: [], labels: {}, portBindings: {} } as unknown as ContainerCreateSpec,
    imageId: "sha256:synthetic",
    running: false,
    state: "exited",
    sessions: new Map(),
    sentKeys: new Map(),
  });
}

function setup() {
  const home = fs.realpathSync(tempDir("agentbox-broker-dirs-"));
  const dataDir = path.join(home, "data");
  const root = path.join(dataDir, "broker");
  const dir = (name: string) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "broker.sock"), "");
    return path.join(root, name);
  };
  return { env: { home, dataDir }, home, root, dir };
}

describe("removeUnusedBrokerDirs", () => {
  it("removes only the directories no container uses, and follows no link", async () => {
    const { env, home, root, dir } = setup();
    const docker = new MemoryDocker();
    addContainer(docker, "claude-agent-proj-live-00000001");
    addContainer(docker, "claude-agent-proj-legacy-00000002", [
      `${path.join(root, "claude-agent-proj-legacy-00000002")}:/run/agentbox-broker:ro`,
    ]);
    // Recreated since the hashed names: its per-name directory is a leftover.
    addContainer(docker, "claude-agent-proj-recreated-00000005", [
      `${path.join(root, brokerDirName("claude-agent-proj-recreated-00000005"))}:/run/agentbox-broker:ro`,
    ]);
    addContainer(docker, "claude-agent-proj-bound-00000003", [
      `${path.join(root, "mounted")}:/run/agentbox-broker:ro`,
    ]);
    dir(brokerDirName("claude-agent-proj-live-00000001"));
    dir("claude-agent-proj-legacy-00000002");
    dir("mounted");
    dir("claude-agent-proj-recreated-00000005");
    dir(brokerDirName("claude-agent-proj-recreated-00000005"));
    dir("claude-agent-proj-gone-00000004");
    const gone = dir(brokerDirName("claude-agent-proj-gone-00000004"));
    // A link inside a removed directory goes with it; its target stays.
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "x");
    fs.symlinkSync(outside, path.join(gone, "link"));
    // A link and a file directly under broker/ stay.
    fs.symlinkSync(outside, path.join(root, "linked"));
    fs.writeFileSync(path.join(root, "note.txt"), "x");

    const removed = await removeUnusedBrokerDirs(env, docker);

    expect(removed).toEqual(
      [
        brokerDirName("claude-agent-proj-gone-00000004"),
        "claude-agent-proj-gone-00000004",
        "claude-agent-proj-recreated-00000005",
      ].sort(),
    );
    expect(fs.readdirSync(root).sort()).toEqual(
      [
        brokerDirName("claude-agent-proj-live-00000001"),
        "claude-agent-proj-legacy-00000002",
        brokerDirName("claude-agent-proj-recreated-00000005"),
        "linked",
        "mounted",
        "note.txt",
      ].sort(),
    );
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("x");
  });

  it("leaves a broker directory that is itself a link alone", async () => {
    const { env, home, root } = setup();
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(path.join(target, "unused"), { recursive: true });
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.symlinkSync(target, root);
    expect(await removeUnusedBrokerDirs(env, new MemoryDocker())).toEqual([]);
    expect(fs.existsSync(path.join(target, "unused"))).toBe(true);
  });

  it("removes nothing when Docker can't list the containers", async () => {
    const { env, dir } = setup();
    const unused = dir("unused");
    const docker = new MemoryDocker();
    docker.available = false;
    await expect(removeUnusedBrokerDirs(env, docker)).rejects.toThrow();
    expect(fs.existsSync(unused)).toBe(true);
  });

  it("does nothing without a broker directory", async () => {
    const { env } = setup();
    expect(await removeUnusedBrokerDirs(env, new MemoryDocker())).toEqual([]);
  });
});
