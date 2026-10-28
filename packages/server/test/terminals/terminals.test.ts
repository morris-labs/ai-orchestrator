import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMBEDDED_ATTACH_SCRIPT,
  attachCmd,
  externalAttachArgv,
  sideSessionName,
} from "../../src/terminals/attach.js";
import { TOKEN, createHarness, type Harness } from "../api/harness.js";
import { connect } from "../api/ws-client.js";
import { CONTAINER, box } from "../api/fixtures.js";

let h: Harness;
let base: string;
const ended = () => h.hub.replay({ type: "hello", streamId: h.hub.streamId, lastSeq: 0 }).events;

beforeEach(async () => {
  h = await createHarness();
  const port = await h.server.listen(0);
  base = `ws://127.0.0.1:${port}/api/v1`;
});
afterEach(async () => {
  await h.server.close();
});

describe("attach commands", () => {
  it("waits for the session and attaches with -d inside the container", () => {
    expect(attachCmd("claude-agent-x")).toEqual([
      "bash",
      "-c",
      EMBEDDED_ATTACH_SCRIPT,
      "_",
      "claude-agent-x",
    ]);
    expect(EMBEDDED_ATTACH_SCRIPT).toContain('tmux attach -d -t "=$1"');
    expect(EMBEDDED_ATTACH_SCRIPT).toContain("seq 1 300");
  });

  it("builds the external argv without -d", () => {
    const argv = externalAttachArgv({
      container: "c",
      kind: "side",
      session: "s",
      platform: "codex",
      workDir: "/w",
    });
    expect(argv.slice(0, 5)).toEqual(["docker", "exec", "-it", "--detach-keys=ctrl-],ctrl-]", "c"]);
    expect(argv.at(-1)).toBe("s-codex");
    expect(argv[7]).toContain('tmux attach -t "=$1"');
    expect(
      externalAttachArgv({ container: "c", kind: "shell", session: "s", workDir: "/w" }),
    ).toEqual(["docker", "exec", "-it", "-w", "/w", "c", "bash", "-l"]);
    expect(sideSessionName("s", "copilot")).toBe("s-copilot");
  });
});

describe("terminals.open", () => {
  it("attaches to the session and carries bytes both ways", async () => {
    const s = await connect(
      `${base}/terminals?kind=session&boxId=${box.id}&cols=100&rows=30&token=${TOKEN}`,
    );
    await s.until((x) => x.texts.length === 1);
    expect(s.texts[0]).toMatchObject({ type: "ready" });
    expect(h.exec.requests[0]).toMatchObject({
      container: CONTAINER,
      cmd: attachCmd(box.session),
      cols: 100,
      rows: 30,
    });
    const container = h.exec.sessions[0]!.container;
    container.write("hello from tmux");
    await s.until((x) => x.binary.length > 0);
    expect(Buffer.concat(s.binary).toString()).toBe("hello from tmux");
    const received: Buffer[] = [];
    container.on("data", (d: Buffer) => received.push(d));
    s.ws.send(Buffer.from("ls\r"));
    s.ws.send(JSON.stringify({ type: "input", data: "x" }));
    s.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await s.until(
      () => Buffer.concat(received).toString() === "ls\rx" && h.exec.sizes.length === 1,
    );
    expect(h.exec.sizes[0]).toEqual([120, 40]);
    s.ws.close();
  });

  it("sends exit and emits terminal.ended when the session ends", async () => {
    h.core.views.set(box.id, { ...h.core.views.get(box.id)!, status: "running" });
    const s = await connect(`${base}/terminals?kind=session&boxId=${box.id}&token=${TOKEN}`);
    await s.until((x) => x.texts.length === 1);
    h.exec.sessions[0]!.exitCode = 0;
    h.core.views.set(box.id, { ...h.core.views.get(box.id)!, status: "stopped" });
    h.exec.sessions[0]!.container.end();
    await s.until((x) => x.texts.length === 2);
    expect(s.texts[1]).toEqual({ type: "exit", exitCode: 0 });
    await s.closed;
    await s.until(() => ended().some((e) => e.type === "terminal.ended"));
    expect(ended().find((e) => e.type === "terminal.ended")).toMatchObject({
      boxId: box.id,
      kind: "session",
      exitCode: 0,
      unexpected: true,
    });
  });

  it("closes the exec when the client leaves; that end is expected", async () => {
    const s = await connect(`${base}/terminals?kind=session&boxId=${box.id}&token=${TOKEN}`);
    await s.until((x) => x.texts.length === 1);
    s.ws.close();
    await s.until(() => h.exec.sessions[0]!.closed && ended().length > 0);
    expect(ended()[0]).toMatchObject({ type: "terminal.ended", unexpected: false });
  });

  it("opens a side session and a shell", async () => {
    const side = await connect(
      `${base}/terminals?kind=side&boxId=${box.id}&platform=codex&token=${TOKEN}`,
    );
    await side.until((x) => x.texts.length === 1);
    expect(h.exec.requests[0]!.cmd.at(-1)).toBe(`${box.session}-codex`);
    side.ws.close();
    const shell = await connect(
      `${base}/terminals?kind=shell&projectId=example-app-1a2b3c4d&token=${TOKEN}`,
    );
    await shell.until((x) => x.texts.length === 1);
    expect(h.exec.requests[1]).toMatchObject({
      cmd: ["bash", "-l"],
      workingDir: "/work/example-app",
      container: CONTAINER,
    });
    shell.ws.close();
    const boxShell = await connect(`${base}/terminals?kind=shell&boxId=${box.id}&token=${TOKEN}`);
    await boxShell.until((x) => x.texts.length === 1);
    expect(h.exec.requests[2]).toMatchObject({ workingDir: box.worktree });
    boxShell.ws.close();
  });

  it("sends an error frame for a bad query or an unknown box", async () => {
    const bad = await connect(`${base}/terminals?kind=session&token=${TOKEN}`);
    await bad.until((x) => x.texts.length === 1);
    expect(bad.texts[0]).toMatchObject({ type: "error", error: { code: "validation" } });
    expect((await bad.closed).code).toBe(1008);
    const missing = await connect(
      `${base}/terminals?kind=session&boxId=claude-agent-zz&token=${TOKEN}`,
    );
    await missing.until((x) => x.texts.length === 1);
    expect(missing.texts[0]).toMatchObject({ type: "error", error: { code: "not_found" } });
  });

  it("reports a failed exec", async () => {
    h.exec.fail = Object.assign(new Error("daemon down"), { code: "docker_unavailable" });
    const s = await connect(`${base}/terminals?kind=session&boxId=${box.id}&token=${TOKEN}`);
    await s.until((x) => x.texts.length === 1);
    expect(s.texts[0]).toMatchObject({ type: "error", error: { code: "docker_unavailable" } });
    expect((await s.closed).code).toBe(1011);
  });

  it("answers a terminal control frame that is not JSON with an error", async () => {
    const s = await connect(`${base}/terminals?kind=session&boxId=${box.id}&token=${TOKEN}`);
    await s.until((x) => x.texts.length === 1);
    s.ws.send("not json");
    await s.until((x) => x.texts.length === 2);
    expect(s.texts[1]).toMatchObject({ type: "error", error: { code: "validation" } });
    s.ws.close();
  });
});

describe("jobs.stream", () => {
  it("sends the backlog, live output, input, and the exit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const input: Buffer[] = [];
    const job = h.jobs.start({ kind: "ssh_copy_id", command: "ssh-copy-id a@b" }, async (io) => {
      io.write("Password: ");
      io.onInput((d) => input.push(d));
      await gate;
      io.write("\r\nDone.\r\n");
      return { exitCode: 0 };
    });
    await new Promise((r) => setTimeout(r, 10));
    const s = await connect(`${base}/jobs/${job.id}/stream?token=${TOKEN}`);
    await s.until((x) => x.texts.length === 1 && x.binary.length === 1);
    expect(s.texts[0]).toEqual({ type: "ready", terminalId: job.id });
    expect(s.binary[0]!.toString()).toBe("Password: ");
    s.ws.send(Buffer.from("secret\r"));
    await s.until(() => input.length === 1);
    release();
    await s.until((x) => x.texts.length === 2);
    expect(s.texts[1]).toEqual({ type: "exit", exitCode: 0 });
    expect(Buffer.concat(s.binary).toString()).toContain("Done.");
  });

  it("refuses an unknown job", async () => {
    const s = await connect(`${base}/jobs/nope/stream?token=${TOKEN}`);
    await s.until((x) => x.texts.length === 1);
    expect(s.texts[0]).toMatchObject({ type: "error", error: { code: "not_found" } });
  });
});
