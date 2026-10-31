import { spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { DockerExecBackend, TERMINAL_ID_ENV, hangupCmd } from "../../src/terminals/exec.js";

function sleeper(env: NodeJS.ProcessEnv) {
  const child = spawn("sleep", ["30"], { env, stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.on("exit", (_code, signal) => resolve(signal)),
  );
  return { child, exited };
}

describe("hangupCmd", () => {
  it("sends SIGHUP to the terminal's processes and spares the rest", async () => {
    const mine = sleeper({ ...process.env, [TERMINAL_ID_ENV]: "t-1" });
    const other = sleeper({ ...process.env, [TERMINAL_ID_ENV]: "t-10" });
    const [cmd, ...args] = hangupCmd("t-1");
    const r = spawnSync(cmd as string, args, { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(await mine.exited).toBe("SIGHUP");
    expect(other.child.exitCode).toBeNull();
    expect(other.child.signalCode).toBeNull();
    other.child.kill();
    await other.exited;
  });

  it("spares a process that detached into its own session, and its children", async () => {
    // A tmux server started from a tab carries the tab's id, and so do its panes.
    const env = { ...process.env, [TERMINAL_ID_ENV]: "t-2" };
    const mine = sleeper(env);
    const server = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pane = Number(
      await new Promise<string>((resolve) => server.stdout.once("data", (d) => resolve(String(d)))),
    );
    const [cmd, ...args] = hangupCmd("t-2");
    expect(spawnSync(cmd as string, args).status).toBe(0);
    expect(await mine.exited).toBe("SIGHUP");
    await new Promise((r) => setTimeout(r, 200));
    // The shell waits for its child, so it exits as soon as either one is hung up.
    expect(server.exitCode).toBeNull();
    expect(server.signalCode).toBeNull();
    expect(alive(pane)).toBe(true);
    process.kill(-server.pid!, "SIGKILL");
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("DockerExecBackend", () => {
  it("marks the exec with a terminal id and hangs it up on close", async () => {
    const execs: { Cmd: string[]; Env?: string[] }[] = [];
    const starts: unknown[] = [];
    const stream = new PassThrough();
    const docker = {
      getContainer: () => ({
        exec: async (opts: { Cmd: string[]; Env?: string[] }) => {
          execs.push(opts);
          return {
            start: async (o: unknown) => {
              starts.push(o);
              return stream;
            },
            resize: async () => undefined,
            inspect: async () => ({ ExitCode: null }),
          };
        },
      }),
    } as unknown as Docker;
    const session = await new DockerExecBackend(docker).start({
      container: "c",
      cmd: ["bash", "-l"],
      cols: 80,
      rows: 24,
    });
    const idVar = execs[0]!.Env!.find((e) => e.startsWith(`${TERMINAL_ID_ENV}=`))!;
    const id = idVar.slice(TERMINAL_ID_ENV.length + 1);
    session.close();
    await expect.poll(() => execs.length).toBe(2);
    expect(execs[1]!.Cmd).toEqual(hangupCmd(id));
    expect(stream.destroyed).toBe(true);
  });

  it("uses the terminal id it is given", async () => {
    const envs: string[][] = [];
    const docker = {
      getContainer: () => ({
        exec: async (opts: { Env?: string[] }) => {
          envs.push(opts.Env ?? []);
          return {
            start: async () => new PassThrough(),
            resize: async () => undefined,
            inspect: async () => ({ ExitCode: null }),
          };
        },
      }),
    } as unknown as Docker;
    await new DockerExecBackend(docker).start({
      container: "c",
      cmd: ["bash", "-l"],
      cols: 80,
      rows: 24,
      terminalId: "tab-1",
    });
    expect(envs[0]).toContain(`${TERMINAL_ID_ENV}=tab-1`);
  });
});
