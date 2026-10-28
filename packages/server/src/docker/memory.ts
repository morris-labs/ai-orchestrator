// An in-memory `DockerClient` for tests and for the server's dry-run mode. It
// keeps containers in a map, plays the keeper by writing the sessions state
// file into the container's `/run/claude-box` bind, and understands the tmux
// commands the core sends through `exec`.
import fs from "node:fs";
import path from "node:path";
import { START_SESSION_PATH, STATE_MOUNT } from "./scripts.js";
import {
  DockerUnavailableError,
  type ContainerCreateSpec,
  type ContainerInspect,
  type ContainerSummary,
  type DockerClient,
  type ExecOptions,
  type ExecResult,
  type ImageBuildOptions,
  type ImageInspect,
  type RunOnceOptions,
  type StatsSample,
} from "./types.js";

export interface MemoryContainer {
  id: string;
  spec: ContainerCreateSpec;
  imageId: string;
  running: boolean;
  state: string;
  sessions: Map<string, { workDir: string; command: string }>;
  /** Text sent with `tmux send-keys`, per session. */
  sentKeys: Map<string, string[]>;
}

export interface MemoryCall {
  method: string;
  args: unknown[];
}

export type ExecHandler = (
  container: MemoryContainer,
  options: ExecOptions,
) => ExecResult | undefined;

export class MemoryDocker implements DockerClient {
  readonly containers = new Map<string, MemoryContainer>();
  readonly images = new Map<string, ImageInspect>();
  readonly calls: MemoryCall[] = [];
  /** False makes every call throw `DockerUnavailableError`, as an unreachable daemon does. */
  available = true;
  /** Commands whose session dies right away (exit 2), matched by substring. */
  failingCommands: string[] = [];
  /** Answers to `runOnce`, keyed by the joined command. */
  runOnceAnswers = new Map<string, ExecResult>();
  /** Handles exec commands the double does not know. */
  execHandler: ExecHandler | undefined;
  /** Output lines a build produces, and whether it succeeds. */
  buildResult: { lines: string[]; ok: boolean; error?: string } = {
    lines: ["Step 1/1\n"],
    ok: true,
  };
  private nextId = 1;
  private cpuTick = 0;

  private record(method: string, ...args: unknown[]): void {
    if (!this.available) throw new DockerUnavailableError();
    this.calls.push({ method, args });
  }

  /** Calls of one method. */
  callsOf(method: string): MemoryCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Adds an image, with the given labels. */
  addImage(
    name: string,
    labels: Record<string, string> = {},
    id = `sha256:${name}-1`,
  ): ImageInspect {
    const image = { id, created: "2026-10-01T00:00:00.000Z", labels };
    this.images.set(name, image);
    return image;
  }

  private find(nameOrId: string): MemoryContainer | undefined {
    return (
      this.containers.get(nameOrId) ?? [...this.containers.values()].find((c) => c.id === nameOrId)
    );
  }

  /** The host directory bound to the keeper's state mount, if any. */
  private stateHostDir(c: MemoryContainer): string | undefined {
    const bind = c.spec.binds.find((b) => b.endsWith(`:${STATE_MOUNT}`));
    return bind ? bind.slice(0, bind.length - STATE_MOUNT.length - 1) : undefined;
  }

  /** Writes the sessions file the way the keeper does. */
  writeState(c: MemoryContainer): void {
    const dir = this.stateHostDir(c);
    if (!dir || !c.running) return;
    fs.mkdirSync(dir, { recursive: true });
    const names = [...c.sessions.keys()].map((s) => `${s}\n`).join("");
    fs.writeFileSync(path.join(dir, "sessions.tmp"), names);
    fs.renameSync(path.join(dir, "sessions.tmp"), path.join(dir, "sessions"));
  }

  /** Rewrites every running container's sessions file, as the keepers do each second. */
  tick(): void {
    for (const c of this.containers.values()) this.writeState(c);
  }

  /** Ends a session from the inside, as when the CLI exits. */
  endSession(container: string, session: string): void {
    const c = this.containers.get(container);
    if (!c) return;
    c.sessions.delete(session);
    this.writeState(c);
  }

  /** Lets an idle container's keeper exit, as it does after its grace period. */
  expireIdle(container: string): void {
    const c = this.containers.get(container);
    if (c && c.sessions.size === 0) this.halt(c);
  }

  private halt(c: MemoryContainer): void {
    c.running = false;
    c.state = "exited";
    c.sessions.clear();
    const dir = this.stateHostDir(c);
    if (dir) fs.rmSync(path.join(dir, "sessions"), { force: true });
    if (c.spec.autoRemove) this.containers.delete(c.spec.name);
  }

  async ping(): Promise<boolean> {
    return this.available;
  }

  async listContainers(
    options: { all?: boolean; size?: boolean; status?: string; nameRegex?: string } = {},
  ): Promise<ContainerSummary[]> {
    this.record("listContainers", options);
    const re = new RegExp(options.nameRegex ?? "^claude-agent-");
    return [...this.containers.values()]
      .filter((c) => re.test(c.spec.name))
      .filter((c) => (options.all ? true : c.running))
      .filter((c) => (options.status ? c.state === options.status : true))
      .map((c) => ({
        id: c.id,
        name: c.spec.name,
        state: c.state,
        status: c.running ? "Up 1 minute" : "Exited (0) 1 minute ago",
        imageId: c.imageId,
        labels: { ...c.spec.labels },
        sizeRw: options.size ? 1024 : undefined,
        sizeRootFs: options.size ? 4096 : undefined,
      }));
  }

  async inspectContainer(
    nameOrId: string,
    options: { size?: boolean } = {},
  ): Promise<ContainerInspect | null> {
    this.record("inspectContainer", nameOrId);
    const c = this.find(nameOrId);
    if (!c) return null;
    return {
      id: c.id,
      name: c.spec.name,
      running: c.running,
      state: c.state,
      imageId: c.imageId,
      binds: [...c.spec.binds],
      env: [...c.spec.env],
      labels: { ...c.spec.labels },
      portBindings: JSON.parse(JSON.stringify(c.spec.portBindings)),
      sizeRw: options.size ? 1024 : undefined,
      sizeRootFs: options.size ? 4096 : undefined,
    };
  }

  async createContainer(spec: ContainerCreateSpec): Promise<string> {
    this.record("createContainer", spec);
    if (this.containers.has(spec.name))
      throw new Error(`Conflict. The container name "/${spec.name}" is already in use.`);
    const image = this.images.get(spec.image);
    if (!image) throw new Error(`No such image: ${spec.image}`);
    const id = `c${String(this.nextId++).padStart(11, "0")}`;
    this.containers.set(spec.name, {
      id,
      spec: structuredClone(spec),
      imageId: image.id,
      running: false,
      state: "created",
      sessions: new Map(),
      sentKeys: new Map(),
    });
    return id;
  }

  async startContainer(id: string): Promise<void> {
    this.record("startContainer", id);
    const c = this.find(id);
    if (!c) throw new Error(`No such container: ${id}`);
    c.running = true;
    c.state = "running";
    this.writeState(c);
  }

  async stopContainer(nameOrId: string, timeoutS?: number): Promise<void> {
    this.record("stopContainer", nameOrId, timeoutS);
    const c = this.find(nameOrId);
    if (c && c.running) this.halt(c);
  }

  async removeContainer(nameOrId: string, options: { force?: boolean } = {}): Promise<void> {
    this.record("removeContainer", nameOrId, options);
    const c = this.find(nameOrId);
    if (!c) return;
    if (c.running && !options.force) throw new Error("You cannot remove a running container.");
    this.containers.delete(c.spec.name);
  }

  async exec(container: string, options: ExecOptions): Promise<ExecResult> {
    this.record("exec", container, options);
    const c = this.find(container);
    if (!c || !c.running) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error response from daemon: container ${container} is not running`,
      };
    }
    const cmd = options.cmd;
    if (cmd[0] === START_SESSION_PATH) {
      const [session, workDir, command] = [cmd[1] ?? "", cmd[2] ?? "", cmd[3] ?? ""];
      if (c.sessions.has(session)) {
        return { exitCode: 3, stdout: "", stderr: `session ${session} is already running\n` };
      }
      if (this.failingCommands.some((f) => command.includes(f))) {
        return { exitCode: 2, stdout: "", stderr: `${session} ended right after starting\n` };
      }
      c.sessions.set(session, { workDir, command });
      this.writeState(c);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "tmux" && cmd[1] === "kill-session") {
      const target = (cmd[3] ?? "").replace(/^=/, "");
      if (!c.sessions.delete(target)) {
        return { exitCode: 1, stdout: "", stderr: `can't find session: ${target}\n` };
      }
      this.writeState(c);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
      return {
        exitCode: 0,
        stdout: [...c.sessions.keys()].map((s) => `${s}\n`).join(""),
        stderr: "",
      };
    }
    if (cmd[0] === "tmux" && cmd[1] === "send-keys") {
      const target = (cmd[3] ?? "").replace(/^=/, "");
      if (!c.sessions.has(target))
        return { exitCode: 1, stdout: "", stderr: `can't find session: ${target}\n` };
      const list = c.sentKeys.get(target) ?? [];
      list.push(cmd.slice(4).join(" "));
      c.sentKeys.set(target, list);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return this.execHandler?.(c, options) ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async stats(nameOrId: string): Promise<StatsSample | null> {
    this.record("stats", nameOrId);
    const c = this.find(nameOrId);
    if (!c || !c.running) return null;
    this.cpuTick += 1;
    return {
      cpuTotalUsage: this.cpuTick * 50_000_000,
      systemCpuUsage: this.cpuTick * 1_000_000_000,
      onlineCpus: 4,
      memUsage: 300 * 1024 * 1024,
      memInactiveFile: 100 * 1024 * 1024,
      memLimit: 8 * 1024 * 1024 * 1024,
    };
  }

  async inspectImage(name: string): Promise<ImageInspect | null> {
    this.record("inspectImage", name);
    return this.images.get(name) ?? null;
  }

  async buildImage(
    options: ImageBuildOptions,
    onOutput: (chunk: string) => void,
  ): Promise<{ ok: boolean; error?: string }> {
    this.record("buildImage", options);
    for (const line of this.buildResult.lines) onOutput(line);
    if (this.buildResult.ok) {
      const prev = this.images.get(options.tag);
      const n = prev ? Number(prev.id.split("-").pop()) + 1 : 1;
      this.addImage(options.tag, prev?.labels ?? {}, `sha256:${options.tag}-${n}`);
      return { ok: true };
    }
    return { ok: false, error: this.buildResult.error ?? "build failed" };
  }

  async runOnce(options: RunOnceOptions): Promise<ExecResult> {
    this.record("runOnce", options);
    if (!this.images.has(options.image)) throw new Error(`No such image: ${options.image}`);
    const key = [...options.entrypoint, ...options.cmd].join(" ");
    for (const [k, v] of this.runOnceAnswers) {
      if (key.includes(k)) return v;
    }
    return { exitCode: 1, stdout: "", stderr: "no answer configured" };
  }
}
