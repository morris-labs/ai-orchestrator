// `DockerClient` over the Docker Engine API through dockerode.
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import {
  DockerApiError,
  DockerUnavailableError,
  type ContainerCreateSpec,
  type ContainerInspect,
  type ContainerSummary,
  type DockerClient,
  type ExecOptions,
  type ExecResult,
  type ImageInspect,
  type RunOnceOptions,
  type StatsSample,
} from "./types.js";

const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "EACCES",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode;
}

/** The daemon's own message of a dockerode error, without dockerode's prefix. */
function daemonMessage(err: unknown): string {
  const json = (err as { json?: { message?: unknown } }).json;
  if (json && typeof json.message === "string" && json.message !== "") return json.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turns a connection failure into `DockerUnavailableError` and a refusal
 * from the daemon into `DockerApiError`; rethrows anything else.
 */
function rethrow(err: unknown): never {
  const code = (err as { code?: string }).code;
  if (code && UNREACHABLE.has(code)) throw new DockerUnavailableError();
  const status = statusOf(err);
  if (typeof status === "number" && status >= 400) {
    throw new DockerApiError(status, `Docker: ${daemonMessage(err)}`);
  }
  throw err;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return rethrow(err);
  }
}

/** Whether a 409 message says the daemon is already removing the container. */
export function isRemovalInProgress(message: string): boolean {
  return /removal of container .* is already in progress/i.test(message);
}

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

function mapBindings(
  raw: Record<string, { HostIp?: string; HostPort?: string }[] | null> | undefined,
): ContainerInspect["portBindings"] {
  const out: ContainerInspect["portBindings"] = {};
  for (const [port, list] of Object.entries(raw ?? {})) {
    out[port] = (list ?? []).map((b) => ({ hostIp: b.HostIp ?? "", hostPort: b.HostPort ?? "" }));
  }
  return out;
}

export class DockerodeClient implements DockerClient {
  readonly docker: Docker;

  constructor(docker: Docker = new Docker()) {
    this.docker = docker;
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async listContainers(
    options: { all?: boolean; size?: boolean; status?: string; nameRegex?: string } = {},
  ): Promise<ContainerSummary[]> {
    const filters: Record<string, string[]> = { name: [options.nameRegex ?? "^claude-agent-"] };
    if (options.status) filters.status = [options.status];
    const list = await call(() =>
      this.docker.listContainers({
        all: options.all ?? false,
        size: options.size ?? false,
        filters,
      }),
    );
    return list.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? "").replace(/^\//, ""),
      state: c.State,
      status: c.Status,
      imageId: c.ImageID,
      labels: c.Labels ?? {},
      sizeRw: (c as { SizeRw?: number }).SizeRw,
      sizeRootFs: (c as { SizeRootFs?: number }).SizeRootFs,
    }));
  }

  async inspectContainer(
    nameOrId: string,
    options: { size?: boolean } = {},
  ): Promise<ContainerInspect | null> {
    try {
      const c = await this.docker
        .getContainer(nameOrId)
        .inspect({ size: options.size ?? false } as Docker.ContainerInspectOptions);
      const sized = c as unknown as { SizeRw?: number; SizeRootFs?: number };
      return {
        id: c.Id,
        name: c.Name.replace(/^\//, ""),
        running: c.State.Running,
        state: c.State.Status,
        imageId: c.Image,
        binds: c.HostConfig.Binds ?? [],
        env: c.Config.Env ?? [],
        labels: c.Config.Labels ?? {},
        portBindings: mapBindings(
          c.HostConfig.PortBindings as Record<string, { HostIp?: string; HostPort?: string }[]>,
        ),
        sizeRw: sized.SizeRw,
        sizeRootFs: sized.SizeRootFs,
      };
    } catch (err) {
      if (statusOf(err) === 404) return null;
      return rethrow(err);
    }
  }

  async createContainer(spec: ContainerCreateSpec): Promise<string> {
    const exposed: Record<string, object> = {};
    const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
    for (const [port, list] of Object.entries(spec.portBindings)) {
      exposed[port] = {};
      bindings[port] = list.map((b) => ({ HostIp: b.hostIp, HostPort: b.hostPort }));
    }
    const c = await call(() =>
      this.docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Cmd: spec.cmd,
        Env: spec.env,
        User: spec.user,
        WorkingDir: spec.workingDir,
        Labels: spec.labels,
        Tty: spec.tty,
        OpenStdin: spec.openStdin,
        ExposedPorts: exposed,
        HostConfig: {
          Binds: spec.binds,
          AutoRemove: spec.autoRemove,
          PortBindings: bindings,
          ...(spec.capDrop ? { CapDrop: spec.capDrop } : {}),
        },
      }),
    );
    return c.id;
  }

  async startContainer(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).start();
    } catch (err) {
      if (statusOf(err) === 304) return;
      rethrow(err);
    }
  }

  async stopContainer(nameOrId: string, timeoutS = 20): Promise<void> {
    try {
      await this.docker.getContainer(nameOrId).stop({ t: timeoutS });
    } catch (err) {
      const s = statusOf(err);
      if (s === 304 || s === 404) return;
      rethrow(err);
    }
  }

  /**
   * Removes a container. A container that is gone, or that the daemon is
   * already removing (409, as for an auto-remove container that just
   * exited), counts as removed; callers that reuse the name wait for it to
   * disappear.
   */
  async removeContainer(nameOrId: string, options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.docker.getContainer(nameOrId).remove({ force: options.force ?? false });
    } catch (err) {
      const s = statusOf(err);
      if (s === 404) return;
      if (s === 409 && isRemovalInProgress(daemonMessage(err))) return;
      rethrow(err);
    }
  }

  async exec(container: string, options: ExecOptions): Promise<ExecResult> {
    const exec = await call(() =>
      this.docker.getContainer(container).exec({
        Cmd: options.cmd,
        User: options.user,
        Env: options.env,
        WorkingDir: options.workingDir,
        AttachStdin: options.stdin !== undefined,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      }),
    );
    const withStdin = options.stdin !== undefined;
    const stream = await call(() => exec.start({ hijack: true, stdin: withStdin }));
    // The input is written without half-closing the hijacked connection, so
    // a command that takes input gets no end-of-file and must stop reading
    // on its own, as the root setup step does after one line.
    if (withStdin) stream.write(options.stdin);
    const out = new PassThrough();
    const err = new PassThrough();
    this.docker.modem.demuxStream(stream, out, err);
    const done = new Promise<void>((resolve) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", () => resolve());
    });
    const outText = collect(out);
    const errText = collect(err);
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs) {
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, options.timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    } else {
      await done;
    }
    out.end();
    err.end();
    const [stdout, stderr] = await Promise.all([outText, errText]);
    if (timedOut) {
      (stream as { destroy?: () => void }).destroy?.();
      return { exitCode: null, stdout, stderr: stderr || "command timed out" };
    }
    const info = await call(() => exec.inspect());
    return { exitCode: info.ExitCode ?? null, stdout, stderr };
  }

  async stats(nameOrId: string): Promise<StatsSample | null> {
    try {
      const s = (await this.docker
        .getContainer(nameOrId)
        .stats({ stream: false, "one-shot": true } as { stream: false })) as unknown as {
        cpu_stats?: {
          cpu_usage?: { total_usage?: number };
          system_cpu_usage?: number;
          online_cpus?: number;
        };
        memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number } };
      };
      return {
        cpuTotalUsage: s.cpu_stats?.cpu_usage?.total_usage ?? 0,
        systemCpuUsage: s.cpu_stats?.system_cpu_usage ?? 0,
        onlineCpus: s.cpu_stats?.online_cpus ?? 1,
        memUsage: s.memory_stats?.usage ?? 0,
        memInactiveFile: s.memory_stats?.stats?.inactive_file ?? 0,
        memLimit: s.memory_stats?.limit ?? 0,
      };
    } catch (err) {
      if (statusOf(err) === 404 || statusOf(err) === 409) return null;
      return rethrow(err);
    }
  }

  async inspectImage(name: string): Promise<ImageInspect | null> {
    try {
      const i = await this.docker.getImage(name).inspect();
      return {
        id: i.Id,
        created: new Date(i.Created).toISOString(),
        labels: i.Config?.Labels ?? {},
      };
    } catch (err) {
      if (statusOf(err) === 404) return null;
      return rethrow(err);
    }
  }

  async runOnce(options: RunOnceOptions): Promise<ExecResult> {
    const c = await call(() =>
      this.docker.createContainer({
        Image: options.image,
        Entrypoint: options.entrypoint,
        Cmd: options.cmd,
        Tty: false,
        ...(options.env ? { Env: options.env } : {}),
        ...(options.user ? { User: options.user } : {}),
        HostConfig: { AutoRemove: false, ...(options.binds ? { Binds: options.binds } : {}) },
      }),
    );
    try {
      await c.start();
      const wait = c.wait() as Promise<{ StatusCode: number }>;
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        wait,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), options.timeoutMs ?? 120000);
        }),
      ]);
      clearTimeout(timer);
      const logs = (await c.logs({ stdout: true, stderr: true, follow: false })) as Buffer;
      const out = new PassThrough();
      const err = new PassThrough();
      const outText = collect(out);
      const errText = collect(err);
      demuxBuffer(logs, out, err);
      out.end();
      err.end();
      return {
        exitCode: result ? result.StatusCode : null,
        stdout: await outText,
        stderr: await errText,
      };
    } finally {
      await c.remove({ force: true }).catch(() => undefined);
    }
  }
}

/** Splits a multiplexed log buffer (8-byte frame headers) into stdout and stderr. */
export function demuxBuffer(
  buf: Buffer,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
): void {
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const size = buf.readUInt32BE(i + 4);
    const payload = buf.subarray(i + 8, i + 8 + size);
    (type === 2 ? err : out).write(payload);
    i += 8 + size;
  }
}
