// Listener discovery: parsers, process-tree mapping, and a real local listener.
import net from "node:net";
import { ListenerSchema } from "@aio/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execRunner, type CommandRunner } from "../../src/api/runner.js";
import { silentLogger } from "../../src/main/logger.js";
import {
  parentPid,
  PANES_FORMAT,
  parsePanes,
  parseProcNetTcp,
  parseSs,
  scanListeners,
  sessionToBoxId,
  socketOwners,
  type ProcFs,
} from "../../src/ports/scan.js";
import { PortWatcher } from "../../src/ports/watcher.js";
import { CONTAINER, newHub } from "../api/fixtures.js";

const SS = `LISTEN 0      511          0.0.0.0:5173       0.0.0.0:*    users:(("node",pid=120,fd=20))
LISTEN 0      4096            [::]:5173          [::]:*    users:(("node",pid=120,fd=21))
LISTEN 0      128        127.0.0.1:8080       0.0.0.0:*
LISTEN 0      4096               *:9000             *:*    users:(("my server",pid=300,fd=3))
UNCONN 0 0 0.0.0.0:68 0.0.0.0:*
garbage`;

const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 0100007F:D3A2 01 00000000:00000000 00:00000000 00000000  1000        0 5555 1 0000000000000000 20 4 30 10 -1`;

/** A fake /proc: pid 120 (node) under 110 (bash) under the tmux pane 100. */
function fakeProc(): ProcFs {
  const files: Record<string, string> = {
    "/proc/net/tcp": PROC_TCP,
    "/proc/net/tcp6": "header\n",
    "/proc/120/stat": "120 (node) S 110 120 100 0",
    "/proc/110/stat": "110 (bash -c) S 100 110 100 0",
    "/proc/100/stat": "100 (claude) S 50 100 100 0",
    "/proc/50/stat": "50 (tmux: server) S 1 50 50 0",
    "/proc/120/comm": "node\n",
  };
  const links: Record<string, string> = {
    "/proc/120/fd/20": "socket:[4242]",
    "/proc/120/fd/1": "/dev/null",
  };
  return {
    readFile: (p) => files[p] ?? null,
    readdir: (p) =>
      p === "/proc" ? ["self", "50", "100", "110", "120"] : p === "/proc/120/fd" ? ["1", "20"] : [],
    readlink: (p) => links[p] ?? null,
  };
}

const panes = "100 aio-agent-feature\n200 aio-agent-feature-codex\n";

function fakeRunner(ss: { code: number; stdout: string }): CommandRunner {
  return {
    run: async (program, args) => {
      if (program === "ss") return { ...ss, stderr: "" };
      if (program === "tmux" && args.at(-1) === PANES_FORMAT)
        return { code: 0, stdout: panes, stderr: "" };
      return { code: 127, stdout: "", stderr: "" };
    },
  };
}

describe("parsers", () => {
  it("parses ss output", () => {
    expect(parseSs(SS)).toEqual([
      { port: 5173, proto: "tcp", process: "node", pid: 120 },
      { port: 5173, proto: "tcp6", process: "node", pid: 120 },
      { port: 8080, proto: "tcp", process: null, pid: null },
      { port: 9000, proto: "tcp6", process: "my server", pid: 300 },
    ]);
  });

  it("parses /proc/net/tcp listeners only", () => {
    expect(parseProcNetTcp(PROC_TCP, "tcp")).toEqual([
      { port: 5173, proto: "tcp", process: null, pid: null, inode: "4242" },
    ]);
  });

  it("finds socket owners and parent pids", () => {
    const proc = fakeProc();
    expect(socketOwners(proc, new Set(["4242"]))).toEqual(new Map([["4242", 120]]));
    expect(socketOwners(proc, new Set())).toEqual(new Map());
    expect(parentPid(proc, 110)).toBe(100);
    expect(parentPid(proc, 999)).toBeNull();
  });

  it("parses real tmux 3.6 output in PANES_FORMAT", () => {
    // Captured from tmux 3.6 in the image with `tmux list-panes -a -F "#{pane_pid} #{session_name}"`.
    const real = "762 aio-agent-aio-hostcheck-bmrt\n3779 aio-agent-aio-hostcheck-bmrt\n";
    expect(parsePanes(real)).toEqual(
      new Map([
        [762, "aio-agent-aio-hostcheck-bmrt"],
        [3779, "aio-agent-aio-hostcheck-bmrt"],
      ]),
    );
  });

  it("keeps spaces inside a session name and skips malformed lines", () => {
    expect(parsePanes("42 my box name\nnot-a-pid name\n7\n\n")).toEqual(
      new Map([[42, "my box name"]]),
    );
  });

  it("ignores the old tab format, which tmux 3.6 prints as an underscore", () => {
    expect(parsePanes("aio-agent-feature_100\n")).toEqual(new Map());
  });

  it("asks tmux for the pid first, separated by a space", () => {
    expect(PANES_FORMAT).toBe("#{pane_pid} #{session_name}");
  });

  it("parses tmux panes", () => {
    expect(parsePanes(panes)).toEqual(
      new Map([
        [100, "aio-agent-feature"],
        [200, "aio-agent-feature-codex"],
      ]),
    );
  });

  it("maps sessions to boxes, side sessions included", () => {
    const live = new Set(["aio-agent-a", "aio-agent-a-codex", "aio-agent-b-codex"]);
    expect(sessionToBoxId("aio-agent-a", live)).toBe("aio-agent-a");
    expect(sessionToBoxId("aio-agent-a-codex", live)).toBe("aio-agent-a");
    expect(sessionToBoxId("aio-agent-b-codex", live)).toBe("aio-agent-b-codex");
    expect(sessionToBoxId("scratch", live)).toBeNull();
  });
});

describe("scanListeners", () => {
  it("maps ss listeners to the box whose pane owns the process", async () => {
    const listeners = await scanListeners({
      runner: fakeRunner({ code: 0, stdout: SS }),
      proc: fakeProc(),
      excludePorts: [9000],
    });
    for (const l of listeners) ListenerSchema.parse(l);
    expect(listeners).toEqual([
      { port: 5173, proto: "tcp", process: "node", boxId: "aio-agent-feature" },
      { port: 5173, proto: "tcp6", process: "node", boxId: "aio-agent-feature" },
      { port: 8080, proto: "tcp", process: null, boxId: null },
    ]);
  });

  it("falls back to /proc when ss is missing", async () => {
    const listeners = await scanListeners({
      runner: fakeRunner({ code: 127, stdout: "" }),
      proc: fakeProc(),
    });
    expect(listeners).toEqual([
      { port: 5173, proto: "tcp", process: "node", boxId: "aio-agent-feature" },
    ]);
  });

  describe("with a real local listener", () => {
    const server = net.createServer();
    let port = 0;
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as net.AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("finds it through ss", async () => {
      const listeners = await scanListeners({ runner: execRunner });
      expect(listeners).toContainEqual(expect.objectContaining({ port, proto: "tcp" }));
    });

    it("finds it and its process through /proc", async () => {
      const noSs: CommandRunner = {
        run: (program, args, o) =>
          program === "ss"
            ? Promise.resolve({ code: 127, stdout: "", stderr: "" })
            : execRunner.run(program, args, o),
      };
      const listeners = await scanListeners({ runner: noSs });
      const mine = listeners.find((l) => l.port === port && l.proto === "tcp");
      expect(mine).toBeDefined();
      expect(mine?.process).toEqual(expect.any(String));
    });
  });
});

describe("PortWatcher", () => {
  it("emits ports.changed only when the listeners change", async () => {
    const hub = newHub();
    const seen = vi.fn();
    hub.subscribe(seen);
    let result = [{ port: 3000, proto: "tcp" as const, process: "node", boxId: null }];
    const watcher = new PortWatcher({
      container: CONTAINER,
      events: hub,
      log: silentLogger,
      scan: async () => result,
    });
    await watcher.poll();
    await watcher.poll();
    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]?.[0]).toMatchObject({
      type: "ports.changed",
      container: CONTAINER,
      listeners: result,
    });
    expect(watcher.list()).toEqual(result);
    result = [];
    await watcher.poll();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(watcher.list()).toEqual([]);
  });

  it("keeps the last list when a scan fails, and polls on its interval", async () => {
    const hub = newHub();
    let calls = 0;
    const watcher = new PortWatcher({
      container: CONTAINER,
      events: hub,
      log: silentLogger,
      intervalMs: 10,
      scan: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    watcher.start();
    await new Promise((r) => setTimeout(r, 45));
    await watcher.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(watcher.list()).toEqual([]);
  });

  it("shares one scan between overlapping polls", async () => {
    let calls = 0;
    const watcher = new PortWatcher({
      container: CONTAINER,
      events: newHub(),
      log: silentLogger,
      scan: async () => {
        calls += 1;
        return [];
      },
    });
    await Promise.all([watcher.poll(), watcher.poll()]);
    expect(calls).toBe(1);
  });
});
