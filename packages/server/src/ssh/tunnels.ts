// SSH remotes: the tunnels the server keeps up for running boxes, the
// connection test, and ssh-copy-id as a job. The tunnel arguments follow
// inventory section 6 (`SshTunnelSession`).
import type { Box, Job, SshRemote, SshTestResultSchema } from "@agentbox/contracts";
import type { z } from "zod";
import { processJob, type JobManager } from "../jobs/jobs.js";
import { commandLine, type ProcessRunner, type SpawnedProcess } from "../jobs/process.js";

export type SshTestResult = z.infer<typeof SshTestResultSchema>;

/** Splits `user@host[:port]` into the ssh target and the port. */
export function parseSshHost(host: string): { target: string; port: number | null } {
  const match = /^(.*?):(\d+)$/.exec(host);
  if (match && !match[1]?.includes("]")) {
    const port = Number(match[2]);
    if (port >= 1 && port <= 65535) return { target: match[1] as string, port };
  }
  return { target: host, port: null };
}

function connectionArgs(remote: SshRemote): { args: string[]; target: string } {
  const { target, port } = parseSshHost(remote.host);
  const args: string[] = [];
  if (remote.identity) args.push("-i", remote.identity);
  if (port !== null) args.push("-p", String(port));
  return { args, target };
}

/** The `ssh` arguments for a remote's tunnel. */
export function tunnelArgs(remote: SshRemote): string[] {
  const { args, target } = connectionArgs(remote);
  return [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=accept-new",
    ...args,
    ...remote.forwards.flatMap((f) => [
      `-${f.direction}`,
      `${f.bindAddress}:${f.bindPort}:${f.destHost}:${f.destPort}`,
    ]),
    target,
  ];
}

/** The most tunnel output kept as `tunnelError`. */
const ERROR_TAIL = 2048;

interface Tunnel {
  name: string;
  signature: string;
  proc: SpawnedProcess | null;
  up: boolean;
  output: string;
  error: string | null;
  attempt: number;
  timer: NodeJS.Timeout | null;
  wanted: boolean;
  /** Bumped on every start, so the exit of an older process is ignored. */
  generation: number;
}

export interface SshTunnelManagerOptions {
  runner: ProcessRunner;
  remotes: () => Promise<SshRemote[]>;
  /** Delays before each reconnect attempt; the last one repeats. */
  reconnectDelaysMs?: number[];
  /** How long a tunnel must stay up before the backoff resets. */
  stableAfterMs?: number;
  log?: (msg: string) => void;
}

/**
 * Keeps one tunnel per remote that a running box references. A tunnel is
 * ref-counted over the running boxes: it starts with the first box that
 * names its remote and stops after the last one.
 */
export class SshTunnelManager {
  private readonly tunnels = new Map<string, Tunnel>();
  private readonly delays: number[];
  private remotesByName = new Map<string, SshRemote>();

  constructor(private readonly opts: SshTunnelManagerOptions) {
    this.delays = opts.reconnectDelaysMs ?? [1000, 2000, 5000, 10_000, 30_000];
  }

  /** Brings the tunnels in line with the running boxes and the stored remotes. */
  async sync(runningBoxes: Pick<Box, "id" | "sshRemoteRefs">[]): Promise<void> {
    const remotes = await this.opts.remotes();
    this.remotesByName = new Map(remotes.map((r) => [r.name, r]));
    const wanted = new Set<string>();
    for (const box of runningBoxes) {
      for (const ref of box.sshRemoteRefs) if (this.remotesByName.has(ref)) wanted.add(ref);
    }
    for (const tunnel of this.tunnels.values()) {
      if (!wanted.has(tunnel.name)) this.stop(tunnel);
    }
    for (const name of wanted) {
      const remote = this.remotesByName.get(name) as SshRemote;
      const signature = commandLine(tunnelArgs(remote));
      const tunnel = this.tunnels.get(name);
      if (!tunnel) {
        this.start(this.newTunnel(name, signature));
      } else if (tunnel.signature !== signature || !tunnel.wanted) {
        this.stop(tunnel);
        tunnel.signature = signature;
        tunnel.attempt = 0;
        this.start(tunnel);
      }
    }
  }

  status(name: string): { tunnelUp: boolean; tunnelError: string | null } {
    const tunnel = this.tunnels.get(name);
    if (!tunnel) return { tunnelUp: false, tunnelError: null };
    return { tunnelUp: tunnel.wanted && tunnel.up, tunnelError: tunnel.error };
  }

  /** Restarts a wanted tunnel now; for an unwanted one, clears its error. */
  async reconnect(name: string): Promise<void> {
    const tunnel = this.tunnels.get(name);
    if (!tunnel) return;
    tunnel.error = null;
    if (!tunnel.wanted) return;
    const remote = (await this.opts.remotes()).find((r) => r.name === name);
    if (remote) {
      this.remotesByName.set(name, remote);
      tunnel.signature = commandLine(tunnelArgs(remote));
    }
    this.stop(tunnel);
    tunnel.attempt = 0;
    this.start(tunnel);
  }

  async stopAll(): Promise<void> {
    for (const tunnel of this.tunnels.values()) this.stop(tunnel);
    this.tunnels.clear();
  }

  private newTunnel(name: string, signature: string): Tunnel {
    const tunnel: Tunnel = {
      name,
      signature,
      proc: null,
      up: false,
      output: "",
      error: null,
      attempt: 0,
      timer: null,
      wanted: true,
      generation: 0,
    };
    this.tunnels.set(name, tunnel);
    return tunnel;
  }

  private start(tunnel: Tunnel): void {
    const remote = this.remotesByName.get(tunnel.name);
    if (!remote) return;
    tunnel.wanted = true;
    tunnel.output = "";
    tunnel.generation += 1;
    const generation = tunnel.generation;
    const args = tunnelArgs(remote);
    this.opts.log?.(`Starting the SSH tunnel for ${tunnel.name}.`);
    const proc = this.opts.runner.spawn("ssh", args);
    tunnel.proc = proc;
    tunnel.up = true;
    const startedAt = Date.now();
    proc.onData((chunk) => {
      tunnel.output = (tunnel.output + chunk.toString()).slice(-ERROR_TAIL);
    });
    proc.onExit((code, error) => {
      if (generation !== tunnel.generation) return;
      tunnel.proc = null;
      tunnel.up = false;
      const detail = error ?? tunnel.output.trim();
      tunnel.error = (detail || `ssh exited with code ${code ?? "unknown"}.`).slice(-ERROR_TAIL);
      if (!tunnel.wanted) return;
      if (Date.now() - startedAt >= (this.opts.stableAfterMs ?? 60_000)) tunnel.attempt = 0;
      const delay = this.delays[Math.min(tunnel.attempt, this.delays.length - 1)] ?? 30_000;
      tunnel.attempt += 1;
      this.opts.log?.(`The SSH tunnel for ${tunnel.name} ended; reconnecting in ${delay} ms.`);
      tunnel.timer = setTimeout(() => {
        tunnel.timer = null;
        if (tunnel.wanted) this.start(tunnel);
      }, delay);
    });
  }

  private stop(tunnel: Tunnel): void {
    tunnel.wanted = false;
    tunnel.generation += 1;
    if (tunnel.timer) clearTimeout(tunnel.timer);
    tunnel.timer = null;
    tunnel.proc?.kill();
    tunnel.proc = null;
    tunnel.up = false;
  }
}

/** Tests a remote: connects without a prompt and runs `true`. */
export async function testConnection(
  runner: ProcessRunner,
  remote: SshRemote,
): Promise<SshTestResult> {
  const { args, target } = connectionArgs(remote);
  const result = await runner.run(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=6",
      "-o",
      "StrictHostKeyChecking=accept-new",
      ...args,
      target,
      "true",
    ],
    { timeoutMs: 15_000 },
  );
  let output = `${result.stdout}${result.stderr}`;
  if (result.timedOut) output += "\nThe connection test timed out.";
  if (result.failedToStart) output = `Can't run ssh: ${output}`;
  return {
    ok: result.code === 0,
    authFailed: /Permission denied|publickey|Too many authentication failures/i.test(output),
    output,
  };
}

/** The `ssh-copy-id` argv that installs the remote's public key. */
export function copyIdArgv(remote: SshRemote): string[] {
  const { target, port } = parseSshHost(remote.host);
  const argv = ["ssh-copy-id"];
  if (remote.identity) argv.push("-i", `${remote.identity}.pub`);
  if (port !== null) argv.push("-p", String(port));
  argv.push(target);
  return argv;
}

/** Runs `ssh-copy-id` in a job terminal, under a pseudo-terminal for the password prompt. */
export function startCopyIdJob(jobs: JobManager, runner: ProcessRunner, remote: SshRemote): Job {
  const argv = copyIdArgv(remote);
  return jobs.start({ kind: "ssh_copy_id", command: commandLine(argv) }, (io) =>
    processJob(io, runner.spawn(argv[0] as string, argv.slice(1), { pty: true })),
  );
}
