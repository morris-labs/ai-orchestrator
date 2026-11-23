// Each vendor's CLI adapter, run against its stand-in in tools/mock-clis,
// sends a message over the team chat bus: the adapter attaches the bus with
// the agent's token, the mock CLI acts out the MCP calls, and the message
// lands as a file whose sender the engine took from the token.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MessageSchema, type Message } from "@aio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { runProcess } from "../../src/adapters/process.js";
import { MemoryEventSink } from "../../src/core.js";
import { silentLogger } from "../../src/main/logger.js";
import { TeamBus, type TeamChannel } from "../../src/team/index.js";
import { MOCK_BIN } from "../adapters/helpers.js";
import { tempDir } from "../tmp.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const Answer = z.object({ done: z.boolean() });

let bus: TeamBus;
let channel: TeamChannel;
let events: MemoryEventSink;
let work: string;
let messages: string;

interface Logged {
  cli: string;
  argv: string[];
  busResults?: { tool: string; isError: boolean; text: string }[];
}

function setup(responses: Record<string, unknown[]>) {
  const scenario = join(work, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(responses).map(([cli, list]) => [cli, { responses: list }]),
      ),
    ),
  );
  const log = join(work, "calls.jsonl");
  const env = {
    MOCK_CLI_SCENARIO: scenario,
    MOCK_CLI_LOG: log,
    CODEX_HOME: join(work, "codex-home"),
    ANTHROPIC_API_KEY: undefined,
  };
  const options = { env, account: "user@example.com" };
  return {
    env,
    claude: new ClaudeAdapter({
      ...options,
      command: join(MOCK_BIN, "claude"),
      bare: false,
      persistSessions: false,
    }),
    codex: new CodexAdapter({ ...options, command: join(MOCK_BIN, "codex") }),
    logged: (): Logged[] =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Logged),
  };
}

function saved(): Message[] {
  if (!existsSync(messages)) return [];
  return readdirSync(messages)
    .sort()
    .map((name) => MessageSchema.parse(JSON.parse(readFileSync(join(messages, name), "utf8"))));
}

const request = (prompt: string, tools: "read-only" | "write" = "write") => ({
  prompt,
  cwd: work,
  tools,
  timeoutMs: 30_000,
  outputSchema: Answer,
});

beforeEach(async () => {
  work = tempDir("aio-team-vendors-");
  messages = join(work, "messages");
  events = new MemoryEventSink("engine:test", "stream-team");
  bus = new TeamBus({ log: silentLogger });
  await bus.start();
  channel = bus.channel({
    buildId: BUILD,
    dir: messages,
    tasks: [{ id: "T1", role: "developer", ownedFiles: ["src/cart.mjs"] }],
    emit: (draft) => {
      events.emit(draft);
    },
  });
});

afterEach(async () => {
  await bus.close();
});

describe("a message from each vendor's mock CLI", () => {
  it("lands from a Claude agent with the sender its token names", async () => {
    const world = setup({
      claude: [
        {
          match: "ASK",
          output: { done: true },
          busCalls: [
            {
              tool: "send_message",
              arguments: { type: "test_dispute", body: "The test wants cents." },
            },
          ],
        },
      ],
    });
    const pass = channel.admit({ seat: "developer", taskId: "T1" });
    for (const tools of ["write", "read-only"] as const) {
      const result = await world.claude.fix({ ...request("ASK", tools), team: pass.attachment });
      expect(result.output).toEqual({ done: true });
    }
    pass.revoke();

    expect(saved().map((m) => [m.id, m.from, m.to, m.body])).toEqual([
      [
        "M1",
        { kind: "seat", seat: "developer", taskId: "T1" },
        { kind: "seat", seat: "test-engineer", taskId: "T1" },
        "The test wants cents.",
      ],
      [
        "M2",
        { kind: "seat", seat: "developer", taskId: "T1" },
        { kind: "seat", seat: "test-engineer", taskId: "T1" },
        "The test wants cents.",
      ],
    ]);
    expect(events.ofType("message.sent").map((e) => e.message.id)).toEqual(["M1", "M2"]);
    const [call] = world.logged();
    expect(call?.argv).toContain("--strict-mcp-config");
    expect(call?.argv.join(" ")).not.toContain(pass.attachment.token);
  });

  it("lands from a Codex agent, on a first call and on a resume", async () => {
    const world = setup({
      codex: [
        {
          match: "ASK",
          output: { done: true },
          sessionId: "thread-1",
          busCalls: [
            {
              tool: "send_message",
              arguments: { type: "contract_question", body: "Is total() sync?" },
            },
          ],
        },
      ],
    });
    const pass = channel.admit({ seat: "test-engineer", taskId: "T1" });
    const first = await world.codex.review({
      ...request("ASK", "read-only"),
      team: pass.attachment,
    });
    await world.codex.continueReview({
      ...request("ASK again", "read-only"),
      sessionId: first.sessionId ?? "",
      team: pass.attachment,
    });
    pass.revoke();

    expect(saved().map((m) => [m.from, m.to, m.routing])).toEqual([
      [
        { kind: "seat", seat: "test-engineer", taskId: "T1" },
        { kind: "seat", seat: "architect", taskId: null },
        "by_type",
      ],
      [
        { kind: "seat", seat: "test-engineer", taskId: "T1" },
        { kind: "seat", seat: "architect", taskId: null },
        "by_type",
      ],
    ]);
    const logged = world.logged();
    expect(logged[1]?.argv.slice(0, 5)).toEqual([
      "exec",
      "--sandbox",
      "danger-full-access",
      "resume",
      "thread-1",
    ]);
    for (const call of logged) expect(call.argv.join(" ")).not.toContain(pass.attachment.token);
  });

  it("can't send as another seat, whatever the agent puts in the arguments", async () => {
    const world = setup({
      claude: [
        {
          output: { done: true },
          busCalls: [
            {
              tool: "send_message",
              arguments: {
                type: "note",
                body: "From the architect, honest.",
                from: { kind: "seat", seat: "architect", taskId: null },
              },
            },
          ],
        },
      ],
    });
    const pass = channel.admit({ seat: "developer", taskId: "T1" });
    await world.claude.fix({ ...request("Forge"), team: pass.attachment });
    pass.revoke();
    expect(saved()).toEqual([]);
    expect(world.logged()[0]?.busResults?.[0]).toMatchObject({ isError: true });
  });

  it("reaches the bus only while the agent's call runs", async () => {
    const world = setup({
      claude: [
        {
          output: { done: true },
          busCalls: [{ tool: "send_message", arguments: { type: "note", body: "Late." } }],
        },
      ],
    });
    const pass = channel.admit({ seat: "developer", taskId: "T1" });
    pass.revoke();
    await world.claude.fix({ ...request("Late"), team: pass.attachment });
    expect(saved()).toEqual([]);
    expect(world.logged()[0]?.busResults?.[0]).toMatchObject({ isError: true });
  });
});

describe("the Codex mock's approval rule", () => {
  it("refuses a bus call when the server doesn't approve its tools, as codex exec does", async () => {
    const world = setup({
      codex: [
        {
          output: { done: true },
          busCalls: [{ tool: "send_message", arguments: { type: "note", body: "Hi." } }],
        },
      ],
    });
    const pass = channel.admit({ seat: "developer", taskId: "T1" });
    const result = await runProcess({
      command: join(MOCK_BIN, "codex"),
      args: [
        "exec",
        "--json",
        "-c",
        `mcp_servers.aio_team.url="${bus.url}"`,
        "-c",
        'mcp_servers.aio_team.bearer_token_env_var="AIO_TEAM_TOKEN"',
        "-",
      ],
      cwd: work,
      input: "Hi",
      env: { ...world.env, AIO_TEAM_TOKEN: pass.attachment.token },
      timeoutMs: 30_000,
    });
    pass.revoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "MCP tool call requires approval, but approval policy is never",
    );
    expect(saved()).toEqual([]);
  });
});
