// `docker exec` with a TTY behind an interface, so tests use a fake stream.
import type { Duplex } from "node:stream";
import type Docker from "dockerode";

export interface ExecRequest {
  container: string;
  cmd: string[];
  env?: string[];
  workingDir?: string;
  cols: number;
  rows: number;
}

/** One running exec: a raw TTY stream in both directions. */
export interface ExecSession {
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void>;
  /** The exit code once the stream ended, or `null` when unknown. */
  exitCode(): Promise<number | null>;
  /** Drops the connection; the process gets a hangup. */
  close(): void;
}

export interface ExecBackend {
  start(request: ExecRequest): Promise<ExecSession>;
}

/** The environment every terminal gets. */
export const TERMINAL_ENV = ["TERM=xterm-256color", "COLORTERM=truecolor"];

/** Runs execs through dockerode. */
export class DockerExecBackend implements ExecBackend {
  constructor(private readonly docker: Docker) {}

  async start(request: ExecRequest): Promise<ExecSession> {
    const exec = await this.docker.getContainer(request.container).exec({
      Cmd: request.cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: [...TERMINAL_ENV, ...(request.env ?? [])],
      WorkingDir: request.workingDir,
      ConsoleSize: [request.rows, request.cols],
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    const resize = async (cols: number, rows: number) => {
      await exec.resize({ h: rows, w: cols });
    };
    await resize(request.cols, request.rows).catch(() => undefined);
    return {
      stream,
      resize,
      exitCode: async () => {
        try {
          const info = await exec.inspect();
          return info.ExitCode ?? null;
        } catch {
          return null;
        }
      },
      close: () => stream.destroy(),
    };
  }
}
