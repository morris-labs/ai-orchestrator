// The team chat bus over HTTP, as an agent's MCP client reaches it: the
// handshake, the tool list, sending, and who the engine says the sender is.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MessageSchema, type Message } from "@aio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryEventSink } from "../../src/core.js";
import { silentLogger } from "../../src/main/logger.js";
import { TEAM_SERVER_NAME, TeamBus, type TeamChannel } from "../../src/team/index.js";
import { tempDir } from "../tmp.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const T0 = Date.parse("2026-10-28T09:00:00.000Z");
const tasks = [
  { id: "T1", role: "developer", ownedFiles: ["src/cart.mjs"] },
  { id: "T2", role: "developer", ownedFiles: ["src/tax/**"] },
];

let bus: TeamBus;
let events: MemoryEventSink;
let dir: string;

function open(): TeamChannel {
  return bus.channel({
    buildId: BUILD,
    dir,
    tasks,
    emit: (draft) => {
      events.emit(draft);
    },
    clock: { now: () => T0, sleep: () => Promise.resolve() },
  });
}

/** Sends one JSON-RPC request the way an MCP client does over streamable HTTP. */
async function rpc(
  token: string | null,
  method: string,
  params?: unknown,
  id: number | null = 1,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(bus.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
      ...(id === null ? {} : { id }),
    }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function send(token: string, args: Record<string, unknown>) {
  const { status, body } = await rpc(token, "tools/call", {
    name: "send_message",
    arguments: args,
  });
  expect(status).toBe(200);
  return body?.result as {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: { id: string };
  };
}

function savedMessages(): Message[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => MessageSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
}

beforeEach(async () => {
  dir = join(tempDir("aio-team-"), "messages");
  events = new MemoryEventSink("engine:test", "stream-team");
  bus = new TeamBus({ log: silentLogger });
  await bus.start();
});

afterEach(async () => {
  await bus.close();
});

describe("the MCP endpoint", () => {
  it("listens on the loopback interface", () => {
    expect(bus.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("answers the handshake and lists send_message without a sender argument", async () => {
    const { attachment } = open().admit({ seat: "developer", taskId: "T1" });
    const init = await rpc(attachment.token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
    });
    const note = await rpc(attachment.token, "notifications/initialized", undefined, null);
    expect(note.status).toBe(202);

    const list = await rpc(attachment.token, "tools/list", {});
    const tools = (list.body?.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["send_message"]);
    const schema = tools[0]?.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["type", "body", "to", "taskId", "paths"]),
    );
    expect(schema.properties).not.toHaveProperty("from");
  });

  it("names the server and its tools in each attachment", () => {
    const { attachment } = open().admit({ seat: "developer", taskId: "T1" });
    expect(attachment).toEqual({
      server: TEAM_SERVER_NAME,
      url: bus.url,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/),
      tools: ["send_message"],
    });
  });
});

describe("sending a message", () => {
  it("saves the message as a file with the sender the token names", async () => {
    const { attachment } = open().admit({ seat: "developer", taskId: "T1" });
    const result = await send(attachment.token, {
      type: "test_dispute",
      body: "The test wants cents; AC1 says dollars.",
      paths: ["test/cart.test.mjs"],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ id: "M1" });
    expect(result.content[0]?.text).toMatch(/M1.*test-engineer/);

    const [saved] = savedMessages();
    expect(saved).toEqual({
      version: 1,
      id: "M1",
      buildId: BUILD,
      from: { kind: "seat", seat: "developer", taskId: "T1" },
      to: { kind: "seat", seat: "test-engineer", taskId: "T1" },
      routing: "by_type",
      type: "test_dispute",
      taskId: "T1",
      milestone: null,
      paths: ["test/cart.test.mjs"],
      body: "The test wants cents; AC1 says dollars.",
      createdAt: new Date(T0).toISOString(),
    });
    expect(readdirSync(dir)).toEqual(["M1.json"]);
  });

  it("sends a message.sent event with the saved message", async () => {
    const { attachment } = open().admit({ seat: "developer", taskId: "T1" });
    await send(attachment.token, { type: "question", body: "Which currency?" });
    const sent = events.ofType("message.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toEqual(savedMessages()[0]);
  });

  it("tells each agent's messages apart by token", async () => {
    const channel = open();
    const dev = channel.admit({ seat: "developer", taskId: "T2" });
    const tester = channel.admit({ seat: "test-engineer", taskId: "T1" });
    await send(tester.attachment.token, { type: "answer", body: "Cents.", to: "developer" });
    await send(dev.attachment.token, { type: "question", body: "Rounding?" });
    expect(savedMessages().map((m) => [m.id, m.from])).toEqual([
      ["M1", { kind: "seat", seat: "test-engineer", taskId: "T1" }],
      ["M2", { kind: "seat", seat: "developer", taskId: "T2" }],
    ]);
  });

  it("gives parallel messages distinct IDs and continues the IDs after a restart", async () => {
    const { attachment } = open().admit({ seat: "developer", taskId: "T1" });
    await Promise.all(
      [1, 2, 3].map((n) => send(attachment.token, { type: "note", body: `Note ${n}.` })),
    );
    await bus.close();
    bus = new TeamBus({ log: silentLogger });
    await bus.start();
    const again = open().admit({ seat: "developer", taskId: "T1" });
    await send(again.attachment.token, { type: "note", body: "After the restart." });
    expect(
      savedMessages()
        .map((m) => m.id)
        .sort(),
    ).toEqual(["M1", "M2", "M3", "M4"]);
  });

  it("reports a bad message to the agent as a tool error and saves nothing", async () => {
    const { attachment } = open().admit({ seat: "developer", taskId: "T1" });
    const result = await send(attachment.token, { type: "file_request", body: "Add a rate." });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/paths/);
    expect(savedMessages()).toEqual([]);
  });

  it("asks a sender with no task to name a task or a milestone", async () => {
    const { attachment } = open().admit({ seat: "project-manager", taskId: null });
    const bad = await send(attachment.token, { type: "note", body: "Status?" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/task or a milestone/);
    const good = await send(attachment.token, { type: "note", body: "Status?", milestone: "M-1" });
    expect(good.isError).toBeFalsy();
  });

  it("passes each saved message to the channel's listeners", async () => {
    const channel = open();
    const seen: string[] = [];
    const stop = channel.onMessage((m) => seen.push(m.id));
    const { attachment } = channel.admit({ seat: "developer", taskId: "T1" });
    await send(attachment.token, { type: "note", body: "One." });
    stop();
    await send(attachment.token, { type: "note", body: "Two." });
    expect(seen).toEqual(["M1"]);
  });

  it("lets the engine post as the owner, which no token can", async () => {
    const channel = open();
    const message = await channel.send(
      { kind: "owner" },
      {
        type: "note",
        body: "Use dollars.",
        to: "developer",
        toTask: "T1",
      },
    );
    expect(message.from).toEqual({ kind: "owner" });
    expect(await channel.list()).toEqual([message]);
  });
});

describe("the sender check", () => {
  it("refuses a sender argument, so an agent can't send as another seat", async () => {
    const { attachment } = open().admit({ seat: "developer", taskId: "T1" });
    for (const forged of [
      { from: { kind: "seat", seat: "architect", taskId: null } },
      { sender: "architect" },
      { seat: "architect" },
    ]) {
      const result = await send(attachment.token, { type: "note", body: "Hi.", ...forged });
      expect(result.isError).toBe(true);
    }
    expect(savedMessages()).toEqual([]);
  });

  it("refuses a request without a token or with an unknown one", async () => {
    open().admit({ seat: "developer", taskId: "T1" });
    expect((await rpc(null, "tools/list", {})).status).toBe(401);
    expect((await rpc("not-a-real-token-0000000000000000", "tools/list", {})).status).toBe(401);
  });

  it("refuses a token once the call it was made for ends", async () => {
    const pass = open().admit({ seat: "developer", taskId: "T1" });
    pass.revoke();
    expect((await rpc(pass.attachment.token, "tools/list", {})).status).toBe(401);
    expect(savedMessages()).toEqual([]);
  });

  it("refuses tokens of a build whose channel closed", async () => {
    const channel = open();
    const pass = channel.admit({ seat: "developer", taskId: "T1" });
    channel.close();
    expect((await rpc(pass.attachment.token, "tools/list", {})).status).toBe(401);
  });
});
