// The thin Docker layer the core uses. `DockerodeClient` implements it over
// the Engine API; `MemoryDocker` implements it in memory for tests.

/** A container as `GET /containers/json` lists it. */
export interface ContainerSummary {
  id: string;
  /** Without the leading slash. */
  name: string;
  /** `created`, `running`, `exited`, and so on. */
  state: string;
  /** Docker's status sentence, such as `Up 3 minutes`. */
  status: string;
  imageId: string;
  labels: Record<string, string>;
  /** Writable layer size, when asked for with `size`. */
  sizeRw?: number;
  sizeRootFs?: number;
}

/** The parts of `GET /containers/:id/json` the core reads. */
export interface ContainerInspect {
  id: string;
  name: string;
  running: boolean;
  /** `created`, `running`, `exited`, and so on. */
  state: string;
  /** The image id the container was created from. */
  imageId: string;
  binds: string[];
  env: string[];
  labels: Record<string, string>;
  /** Host ports bound per container port, such as `{ "20411/tcp": [{ hostIp, hostPort }] }`. */
  portBindings: Record<string, { hostIp: string; hostPort: string }[]>;
  sizeRw?: number;
  sizeRootFs?: number;
}

/** The body of `POST /containers/create`, as the core builds it. */
export interface ContainerCreateSpec {
  name: string;
  image: string;
  user: string;
  workingDir: string;
  cmd: string[];
  env: string[];
  binds: string[];
  /** `"<port>/tcp"` to host bindings. */
  portBindings: Record<string, { hostIp: string; hostPort: string }[]>;
  labels: Record<string, string>;
  tty: boolean;
  openStdin: boolean;
  autoRemove: boolean;
}

export interface ExecOptions {
  cmd: string[];
  user?: string;
  env?: string[];
  workingDir?: string;
  /** Kills the wait after this many milliseconds; the result then has exit code `null`. */
  timeoutMs?: number;
}

export interface ExecResult {
  /** `null` when the command timed out or the exit code is unknown. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** A one-shot stats sample: the raw counters the CPU delta needs. */
export interface StatsSample {
  cpuTotalUsage: number;
  systemCpuUsage: number;
  onlineCpus: number;
  memUsage: number;
  memInactiveFile: number;
  memLimit: number;
}

export interface ImageInspect {
  id: string;
  /** ISO time. */
  created: string;
  labels: Record<string, string>;
}

export interface ImageBuildOptions {
  /** The build context directory. */
  context: string;
  tag: string;
  buildArgs: Record<string, string>;
  noCache: boolean;
  pull: boolean;
}

export interface RunOnceOptions {
  image: string;
  /** Replaces the image's entry point; `[]` clears it. */
  entrypoint: string[];
  cmd: string[];
  timeoutMs?: number;
}

/** Thrown by a client when the daemon does not answer. */
export class DockerUnavailableError extends Error {
  constructor(message = "The Docker daemon is unreachable.") {
    super(message);
    this.name = "DockerUnavailableError";
  }
}

export interface DockerClient {
  /** Whether the daemon answers. */
  ping(): Promise<boolean>;
  /** Containers whose name matches `nameRegex` (default `^claude-agent-`). */
  listContainers(options?: {
    all?: boolean;
    size?: boolean;
    status?: string;
    nameRegex?: string;
  }): Promise<ContainerSummary[]>;
  /** `null` when no such container exists. */
  inspectContainer(nameOrId: string, options?: { size?: boolean }): Promise<ContainerInspect | null>;
  /** Creates a container and returns its id. */
  createContainer(spec: ContainerCreateSpec): Promise<string>;
  startContainer(id: string): Promise<void>;
  /** Stops a container; a missing or stopped container is not an error. */
  stopContainer(nameOrId: string, timeoutS?: number): Promise<void>;
  /** Removes a container; a missing container is not an error. */
  removeContainer(nameOrId: string, options?: { force?: boolean }): Promise<void>;
  exec(container: string, options: ExecOptions): Promise<ExecResult>;
  /** One stats sample, or `null` when the container is gone. */
  stats(nameOrId: string): Promise<StatsSample | null>;
  /** `null` when the image does not exist. */
  inspectImage(name: string): Promise<ImageInspect | null>;
  /** Builds an image, passing every output line to `onOutput`. */
  buildImage(
    options: ImageBuildOptions,
    onOutput: (chunk: string) => void,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Runs a throwaway container (`docker run --rm`) and collects its output. */
  runOnce(options: RunOnceOptions): Promise<ExecResult>;
}
