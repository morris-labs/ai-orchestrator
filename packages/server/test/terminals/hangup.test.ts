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
});

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
});
