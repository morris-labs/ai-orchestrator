import type { SshRemote } from "@aio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { JobManager } from "../../src/jobs/jobs.js";
import {
  copyIdArgv,
  parseSshHost,
  SshTunnelManager,
  startCopyIdJob,
  testConnection,
  tunnelArgs,
} from "../../src/ssh/tunnels.js";
import { FakeRunner, waitFor } from "../setup/fake-runner.js";

const remote: SshRemote = {
  name: "dev",
  host: "me@example.com:2222",
  identity: "/home/me/.ssh/id_ed25519",
  forwards: [
    { direction: "L", bindAddress: "localhost", bindPort: 5432, destHost: "db", destPort: 5432 },
    {
      direction: "R",
      bindAddress: "0.0.0.0",
      bindPort: 9000,
      destHost: "localhost",
      destPort: 3000,
    },
  ],
};
const plain: SshRemote = { name: "plain", host: "me@192.0.2.1", forwards: [] };

describe("ssh arguments", () => {
  it("parses hosts", () => {
    expect(parseSshHost("me@example.com:2222")).toEqual({ target: "me@example.com", port: 2222 });
    expect(parseSshHost("me@example.com")).toEqual({ target: "me@example.com", port: null });
    expect(parseSshHost("example.com:99999")).toEqual({ target: "example.com:99999", port: null });
  });

  it("parses IPv6 hosts", () => {
    expect(parseSshHost("::1")).toEqual({ target: "::1", port: null });
    expect(parseSshHost("me@2001:db8::1")).toEqual({ target: "me@2001:db8::1", port: null });
    expect(parseSshHost("me@[2001:db8::1]:2222")).toEqual({
      target: "me@2001:db8::1",
      port: 2222,
    });
    expect(parseSshHost("[::1]")).toEqual({ target: "::1", port: null });
  });

  it("refuses a host or an identity that ssh would read as an option", async () => {
    const evil: SshRemote = { name: "evil", host: "-oProxyCommand=SYNTHETIC", forwards: [] };
    expect(() => copyIdArgv(evil)).toThrow(expect.objectContaining({ code: "validation" }));
    const runner = new FakeRunner(() => ({ code: 0 }));
    expect(await testConnection(runner, evil)).toMatchObject({ ok: false });
    expect(
      await testConnection(runner, { ...plain, identity: "-oProxyCommand=SYNTHETIC" }),
    ).toMatchObject({ ok: false });
    expect(runner.runs).toHaveLength(0);
    const manager = new SshTunnelManager({ runner, remotes: async () => [evil] });
    await manager.sync([{ id: "aio-agent-x", sshRemoteRefs: ["evil"] }]);
    expect(runner.spawned).toHaveLength(0);
    expect(manager.status("evil")).toEqual({ tunnelUp: false, tunnelError: expect.any(String) });
  });

  it("builds the tunnel argv", () => {
    expect(tunnelArgs(remote)).toEqual([
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-i",
      "/home/me/.ssh/id_ed25519",
      "-p",
      "2222",
      "-L",
      "localhost:5432:db:5432",
      "-R",
      "0.0.0.0:9000:localhost:3000",
      "--",
      "me@example.com",
    ]);
    expect(tunnelArgs(plain).slice(-2)).toEqual(["--", "me@192.0.2.1"]);
    expect(tunnelArgs(plain)).not.toContain("-i");
  });

  it("builds the ssh-copy-id argv", () => {
    expect(copyIdArgv(remote)).toEqual([
      "ssh-copy-id",
      "-i",
      "/home/me/.ssh/id_ed25519.pub",
      "-p",
      "2222",
      "--",
      "me@example.com",
    ]);
    expect(copyIdArgv(plain)).toEqual(["ssh-copy-id", "--", "me@192.0.2.1"]);
  });
});

describe("testConnection", () => {
  it("passes on exit 0", async () => {
    const runner = new FakeRunner(() => ({ code: 0 }));
    expect(await testConnection(runner, remote)).toEqual({
      ok: true,
      authFailed: false,
      output: "",
    });
    expect(runner.runs[0]?.argv).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=6",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-i",
      "/home/me/.ssh/id_ed25519",
      "-p",
      "2222",
      "--",
      "me@example.com",
      "true",
    ]);
    expect(runner.runs[0]?.options.timeoutMs).toBe(15_000);
  });

  it("detects an authentication failure", async () => {
    const runner = new FakeRunner(() => ({
      code: 255,
      stderr: "me@example.com: Permission denied (publickey).",
    }));
    const result = await testConnection(runner, plain);
    expect(result).toMatchObject({ ok: false, authFailed: true });
    expect(result.output).toContain("Permission denied");
  });
});

describe("ssh-copy-id job", () => {
  it("runs under a pty and streams output", async () => {
    const runner = new FakeRunner();
    const jobs = new JobManager();
    const job = startCopyIdJob(jobs, runner, remote);
    expect(job.kind).toBe("ssh_copy_id");
    expect(job.command).toBe(
      "ssh-copy-id -i /home/me/.ssh/id_ed25519.pub -p 2222 -- me@example.com",
    );
    await waitFor(() => runner.spawned.length === 1);
    const proc = runner.spawned[0]!;
    expect(proc.options.pty).toBe(true);
    const attachment = jobs.attach(job.id)!;
    attachment.write(Buffer.from("password\n"));
    expect(proc.written).toEqual(["password\n"]);
    proc.emit("Number of key(s) added: 1\n");
    proc.exit(0);
    await waitFor(() => jobs.get(job.id)?.status === "finished");
    expect(jobs.attach(job.id)!.backlog.toString()).toContain("key(s) added");
  });
});

describe("SshTunnelManager", () => {
  let manager: SshTunnelManager;
  afterEach(async () => manager?.stopAll());

  function setup(remotes: SshRemote[]) {
    const runner = new FakeRunner();
    const list = { remotes };
    manager = new SshTunnelManager({
      runner,
      remotes: async () => list.remotes,
      reconnectDelaysMs: [10, 20],
      upAfterMs: 0,
    });
    return { runner, list };
  }

  it("ref-counts tunnels over running boxes", async () => {
    const { runner } = setup([remote, plain]);
    await manager.sync([
      { id: "aio-agent-a", sshRemoteRefs: ["dev"] },
      { id: "aio-agent-b", sshRemoteRefs: ["dev", "unknown"] },
    ]);
    expect(runner.spawned).toHaveLength(1);
    expect(runner.spawned[0]?.argv[0]).toBe("ssh");
    expect(manager.status("dev")).toEqual({ tunnelUp: true, tunnelError: null });
    expect(manager.status("plain")).toEqual({ tunnelUp: false, tunnelError: null });

    await manager.sync([{ id: "aio-agent-b", sshRemoteRefs: ["dev"] }]);
    expect(runner.spawned).toHaveLength(1);

    await manager.sync([]);
    expect(runner.spawned[0]?.killed).toBe(true);
    expect(manager.status("dev").tunnelUp).toBe(false);

    await manager.sync([{ id: "aio-agent-a", sshRemoteRefs: ["dev"] }]);
    expect(runner.spawned).toHaveLength(2);
  });

  it("restarts a tunnel whose remote changed", async () => {
    const { runner, list } = setup([remote]);
    const boxes = [{ id: "aio-agent-a", sshRemoteRefs: ["dev"] }];
    await manager.sync(boxes);
    await manager.sync(boxes);
    expect(runner.spawned).toHaveLength(1);
    list.remotes = [{ ...remote, forwards: [] }];
    await manager.sync(boxes);
    expect(runner.spawned).toHaveLength(2);
    expect(runner.spawned[0]?.killed).toBe(true);
    expect(runner.spawned[1]?.argv).not.toContain("-L");
  });

  it("doesn't call a tunnel up until ssh has run for a while", async () => {
    const { runner, list } = setup([remote]);
    manager = new SshTunnelManager({ runner, remotes: async () => list.remotes, upAfterMs: 20 });
    await manager.sync([{ id: "aio-agent-a", sshRemoteRefs: ["dev"] }]);
    expect(manager.status("dev").tunnelUp).toBe(false);
    await waitFor(() => manager.status("dev").tunnelUp);
  });

  it("reconnects with backoff and keeps the error", async () => {
    const { runner } = setup([remote]);
    await manager.sync([{ id: "aio-agent-a", sshRemoteRefs: ["dev"] }]);
    runner.spawned[0]!.emit("bind: Address already in use\n");
    runner.spawned[0]!.exit(255);
    expect(manager.status("dev")).toEqual({
      tunnelUp: false,
      tunnelError: "bind: Address already in use",
    });
    await waitFor(() => runner.spawned.length === 2);
    expect(manager.status("dev").tunnelUp).toBe(true);
    runner.spawned[1]!.exit(255);
    expect(manager.status("dev").tunnelError).toBe("ssh exited with code 255.");
    await waitFor(() => runner.spawned.length === 3);
  });

  it("does not reconnect a stopped tunnel, and reconnect restarts a wanted one", async () => {
    const { runner } = setup([remote]);
    await manager.sync([{ id: "aio-agent-a", sshRemoteRefs: ["dev"] }]);
    await manager.reconnect("dev");
    expect(runner.spawned).toHaveLength(2);
    expect(runner.spawned[0]?.killed).toBe(true);
    runner.spawned[0]!.exit(null);
    await manager.sync([]);
    runner.spawned[1]!.exit(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(runner.spawned).toHaveLength(2);
    await manager.reconnect("dev");
    expect(runner.spawned).toHaveLength(2);
    expect(manager.status("dev").tunnelError).toBeNull();
  });
});
