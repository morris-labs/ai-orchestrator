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
  /**
   * The value of `AIO_TERMINAL_ID` for this exec. `serveTerminal` passes
   * the id it reports in `ready`, so the two match; without one, the backend
   * makes one up.
   */
  terminalId?: string;
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
export const TERMINAL_ID_ENV = "AIO_TERMINAL_ID";

/**
 * A shell script that sends SIGHUP to every process in the container whose
 * environment carries `AIO_TERMINAL_ID=$1`. Docker doesn't signal an
 * exec's process when its attach connection closes, so a closed tab would
 * otherwise leave its shell or tmux client running.
 *
 * The script spares a process that detached from the tab and everything it
 * started: one whose topmost ancestor with the same id leads its own session
 * and has no controlling terminal. A tmux server started from a tab is such a
 * process, and its panes inherit the id, so without that check closing the tab
 * would end every pane. The script collects the targets before it signals any,
 * because a child whose shell exits first would otherwise look detached.
 */
export const HANGUP_SCRIPT = [
  "id=$1",
  "has_id() {",
  `  tr '\\0' '\\n' < "/proc/$1/environ" 2>/dev/null | grep -qx "${TERMINAL_ID_ENV}=$id"`,
  "}",
  "detached() {",
  "  q=$1",
  "  while :; do",
  '    st=$(cat "/proc/$q/stat" 2>/dev/null) || return 1',
  "    # The fields after the command name: state, ppid, pgrp, session, tty.",
  "    set -- ${st##*) }",
  '    if [ "$2" -gt 1 ] && has_id "$2"; then q=$2; continue; fi',
  '    [ "$4" = "$q" ] && [ "$5" = 0 ]',
  "    return",
  "  done",
  "}",
  "targets=",
  "for d in /proc/[0-9]*; do",
  "  pid=${d#/proc/}",
  '  has_id "$pid" || continue',
  '  detached "$pid" && continue',
  '  targets="$targets $pid"',
  "done",
  '[ -n "$targets" ] && kill -HUP $targets 2>/dev/null',
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
    const terminalId = request.terminalId ?? randomUUID();
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
