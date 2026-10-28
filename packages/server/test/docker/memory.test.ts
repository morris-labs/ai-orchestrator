import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDocker } from "../../src/docker/memory.js";
import { sessionStartCmd } from "../../src/docker/scripts.js";
import { DockerUnavailableError, type ContainerCreateSpec } from "../../src/docker/types.js";

function spec(stateDir: string): ContainerCreateSpec {
  return {
    name: "claude-agent-proj-x-12345678",
    image: "claude-code",
    user: "tester",
    workingDir: "/w",
    cmd: ["bash"],
    env: [],
    binds: [`${stateDir}:/run/claude-box`],
    portBindings: {},
    labels: {},
    tty: true,
    openStdin: true,
    autoRemove: true,
  };
}

describe("MemoryDocker", () => {
  it("plays the keeper and the tmux commands", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-mem-"));
    const d = new MemoryDocker();
    d.addImage("claude-code");
    const id = await d.createContainer(spec(dir));
    await d.startContainer(id);
    const c = "claude-agent-proj-x-12345678";
    expect((await d.exec(c, { cmd: sessionStartCmd("s1", "/w", "claude") })).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(dir, "sessions"), "utf8")).toBe("s1\n");
    expect((await d.exec(c, { cmd: sessionStartCmd("s1", "/w", "claude") })).exitCode).toBe(3);
    d.failingCommands.push("bad-flag");
    expect(
      (await d.exec(c, { cmd: sessionStartCmd("s2", "/w", "claude bad-flag") })).exitCode,
    ).toBe(2);
    expect((await d.exec(c, { cmd: ["tmux", "list-sessions", "-F", "#S"] })).stdout).toBe("s1\n");
    expect(
      (await d.exec(c, { cmd: ["tmux", "send-keys", "-t", "=s1", "-l", "hi"] })).exitCode,
    ).toBe(0);
    expect(d.containers.get(c)?.sentKeys.get("s1")).toEqual(["-l hi"]);
    expect((await d.exec(c, { cmd: ["tmux", "kill-session", "-t", "=s1"] })).exitCode).toBe(0);
    expect((await d.exec(c, { cmd: ["tmux", "kill-session", "-t", "=s1"] })).stderr).toContain(
      "can't find session",
    );
    d.expireIdle(c);
    expect(d.containers.has(c)).toBe(false);
    expect(await d.inspectContainer(c)).toBeNull();
  });

  it("throws when unavailable and refuses a missing image", async () => {
    const d = new MemoryDocker();
    await expect(d.createContainer(spec("/tmp"))).rejects.toThrow(/No such image/);
    d.available = false;
    await expect(d.listContainers()).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(await d.ping()).toBe(false);
  });

  it("bumps the image id on a build", async () => {
    const d = new MemoryDocker();
    d.addImage("claude-code");
    const lines: string[] = [];
    expect(
      await d.buildImage(
        { context: "/", tag: "claude-code", buildArgs: {}, noCache: true, pull: true },
        (l) => lines.push(l),
      ),
    ).toEqual({ ok: true });
    expect((await d.inspectImage("claude-code"))?.id).toBe("sha256:claude-code-2");
    expect(lines).toEqual(["Step 1/1\n"]);
  });
});
