// `docker exec` with a TTY behind an interface, so tests use a fake stream.
import { randomUUID } from "node:crypto";
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
  /** Drops the connection and sends the process a hangup. */
  close(): void;
}

export interface ExecBackend {
  start(request: ExecRequest): Promise<ExecSession>;
}

/** The environment every terminal gets. */
export const TERMINAL_ENV = ["TERM=xterm-256color", "COLORTERM=truecolor"];

/** The variable that marks every process of one terminal. */
export const TERMINAL_ID_ENV = "AGENTBOX_TERMINAL_ID";

/**
 * A shell script that sends SIGHUP to every process in the container whose
 * environment carries `AGENTBOX_TERMINAL_ID=$1`. Docker doesn't signal an
 * exec's process when its attach connection closes, so a closed tab would
 * otherwise leave its shell or tmux client running.
 */
export const HANGUP_SCRIPT = [
  "for p in /proc/[0-9]*; do",
  `  if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx "${TERMINAL_ID_ENV}=$1"; then`,
  '    kill -HUP "${p#/proc/}" 2>/dev/null',
  "  fi",
  "done",
  "exit 0",
].join("\n");

/** The command that hangs up terminal `id`'s processes. */
export function hangupCmd(id: string): string[] {
  return ["sh", "-c", HANGUP_SCRIPT, "_", id];
}

/** Runs execs through dockerode. */
export class DockerExecBackend implements ExecBackend {
  constructor(private readonly docker: Docker) {}

  async start(request: ExecRequest): Promise<ExecSession> {
    const container = this.docker.getContainer(request.container);
    const terminalId = randomUUID();
    const exec = await container.exec({
      Cmd: request.cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: [...TERMINAL_ENV, `${TERMINAL_ID_ENV}=${terminalId}`, ...(request.env ?? [])],
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
      close: () => {
        stream.destroy();
        void this.hangup(container, terminalId);
      },
    };
  }

  /** Sends SIGHUP to a closed terminal's processes; a container that left needs none. */
  private async hangup(container: Docker.Container, terminalId: string): Promise<void> {
    try {
      const exec = await container.exec({
        Cmd: hangupCmd(terminalId),
        AttachStdout: false,
        AttachStderr: false,
      });
      await exec.start({ Detach: true });
    } catch {
      // The container is gone or stopped; so are the terminal's processes.
    }
  }
}
