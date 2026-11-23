// The team chat bus: one MCP endpoint over streamable HTTP in the engine
// process, on the loopback interface of the project container. Each agent
// call gets its own bearer token, which names the agent's seat and task, so
// the engine knows the sender and an agent can't send as another seat.
// See ADR 0004 and `docs/build-pipeline/team-chat.md`.
import { createHash, randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SendMessageInputSchema, type Message } from "@aio/contracts";
import { toJsonSchema } from "../adapters/output.js";
import type { Logger } from "../api/core-interface.js";
import { bearerToken } from "../api/auth.js";
import {
  MessageRefused,
  TeamChannel,
  type TeamChannelOptions,
  type TeamMember,
  type TeamPass,
  type TeamRegistry,
} from "./channel.js";
import {
  JSONRPC_ERRORS,
  handleMcpMessage,
  rpcError,
  type JsonRpcResponse,
  type McpServerInfo,
  type McpTool,
} from "./mcp.js";

/** The MCP server name agents see; Claude Code names the tools `mcp__aio_team__TOOL`. */
export const TEAM_SERVER_NAME = "aio_team";

/** The path of the MCP endpoint. */
export const TEAM_MCP_PATH = "/mcp";

/** The largest request body the bus reads. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Who a tool call comes from: the channel and member that the token names. */
interface Caller {
  channel: TeamChannel;
  member: TeamMember;
}

export interface TeamBusOptions {
  log: Logger;
  /** The interface to listen on. Default `127.0.0.1`: only the container's own processes reach it. */
  host?: string;
  /** The port. Default 0, a free one. */
  port?: number;
  /** The engine version, which the bus reports in its handshake. */
  version?: string;
}

const describeAddressee = (message: Message): string =>
  message.to.kind === "owner"
    ? "the owner"
    : `${message.to.seat}${message.to.taskId ? ` (task ${message.to.taskId})` : ""}`;

/** The `send_message` tool: the sender comes from the token, never from the arguments. */
const sendMessageTool: McpTool<Caller> = {
  name: "send_message",
  description: [
    "Send a message to another seat of the build team, or to the owner.",
    "Name the addressee in `to` (a seat such as `architect`, or `owner`), or leave it out and",
    "the engine routes the message by its type: a test_dispute goes to the Test engineer, a",
    "file_request to the Developer of the task that owns the first file in `paths`, a",
    "contract_question to the Architect, and any other type to the Project manager.",
    "To answer a message, set `replyTo` to its ID; without `to`, the reply goes to its sender.",
    "You can ask a set number of questions about each task; a question past that cap goes to",
    "the Project manager as an escalation.",
    "The message is about your own task unless you set `taskId` or `milestone`.",
    "The engine records you as the sender.",
  ].join(" "),
  inputSchema: toJsonSchema(SendMessageInputSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async call({ channel, member }, args) {
    try {
      const message = await channel.send(
        { kind: "seat", seat: member.seat, taskId: member.taskId },
        args,
      );
      const text =
        message.routing === "escalated"
          ? `Sent message ${message.id} to the Project manager as an escalation: you asked more questions about this task than the build plan allows. Go on with your work as far as you can without the answer.`
          : `Sent message ${message.id} to ${describeAddressee(message)}.`;
      return {
        text,
        structured: { id: message.id, to: message.to, routing: message.routing },
      };
    } catch (error) {
      if (error instanceof MessageRefused) {
        return { text: `The message wasn't sent: ${error.message}`, isError: true };
      }
      throw error;
    }
  },
};

const TOOLS: readonly McpTool<Caller>[] = [sendMessageTool];

const tokenKey = (token: string): string => createHash("sha256").update(token).digest("hex");

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The team chat bus. Start it once per engine, open a channel per build
 * with `channel()`, and admit each agent call with `TeamChannel.admit()`.
 */
export class TeamBus {
  private readonly tokens = new Map<string, Caller>();
  private readonly channels = new Map<string, TeamChannel>();
  private server: http.Server | null = null;
  private address: AddressInfo | null = null;
  private readonly info: McpServerInfo<Caller>;

  constructor(private readonly options: TeamBusOptions) {
    this.info = {
      name: TEAM_SERVER_NAME,
      version: options.version ?? "0.0.0",
      instructions:
        "The build team's chat. Use send_message to ask, answer, dispute a test, or request a file.",
      tools: TOOLS,
    };
  }

  /** Listens for agents. Resolves once the port is bound. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.options.log.error("The team chat bus failed a request", { error: String(error) });
        if (!res.headersSent) {
          sendJson(res, 500, rpcError(null, JSONRPC_ERRORS.internal, "The bus failed."));
        } else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    // The engine's API keeps the process alive; the bus alone never does.
    server.unref();
    this.server = server;
    this.address = server.address() as AddressInfo;
    this.options.log.info("The team chat bus is listening", { url: this.url });
  }

  /** The MCP endpoint URL. Throws before `start()`. */
  get url(): string {
    if (!this.address) throw new Error("The team chat bus isn't listening.");
    const host =
      this.address.family === "IPv6" ? `[${this.address.address}]` : this.address.address;
    return `http://${host}:${this.address.port}${TEAM_MCP_PATH}`;
  }

  /**
   * Opens the channel of one build. Opening a build's channel again closes
   * the earlier one first, with its tokens, as when a build is loaded again.
   */
  channel(options: TeamChannelOptions): TeamChannel {
    this.channels.get(options.buildId)?.close();
    const registry: TeamRegistry = {
      issue: (channel, member) => this.issue(channel, member),
      release: (channel) => this.release(channel),
    };
    const channel = new TeamChannel(options, registry);
    this.channels.set(options.buildId, channel);
    return channel;
  }

  /** How many tokens the bus accepts: one for each agent call under way. */
  activeTokens(): number {
    return this.tokens.size;
  }

  /** Closes every channel and stops listening. */
  async close(): Promise<void> {
    for (const channel of [...this.channels.values()]) channel.close();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private issue(channel: TeamChannel, member: TeamMember): TeamPass {
    const token = randomBytes(32).toString("base64url");
    const key = tokenKey(token);
    this.tokens.set(key, { channel, member: { ...member } });
    return {
      attachment: {
        server: TEAM_SERVER_NAME,
        url: this.url,
        token,
        tools: TOOLS.map((tool) => tool.name),
      },
      revoke: () => {
        this.tokens.delete(key);
      },
    };
  }

  private release(channel: TeamChannel): void {
    for (const [key, caller] of this.tokens) {
      if (caller.channel === channel) this.tokens.delete(key);
    }
    if (this.channels.get(channel.buildId) === channel) this.channels.delete(channel.buildId);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== TEAM_MCP_PATH) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const token = bearerToken(req.headers.authorization);
    const caller = token === null ? undefined : this.tokens.get(tokenKey(token));
    if (!caller) {
      res.setHeader("www-authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      // No server-sent event stream and no sessions to end.
      res.setHeader("allow", "POST");
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const text = await readBody(req);
    if (text === null) {
      sendJson(res, 413, rpcError(null, JSONRPC_ERRORS.invalidRequest, "The body is too large."));
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      sendJson(res, 400, rpcError(null, JSONRPC_ERRORS.parse, "The body isn't valid JSON."));
      return;
    }
    const messages = Array.isArray(body) ? body : [body];
    const answers: JsonRpcResponse[] = [];
    for (const message of messages) {
      const answer = await handleMcpMessage(message, caller, this.info);
      if (answer) answers.push(answer);
    }
    if (answers.length === 0) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, Array.isArray(body) ? answers : answers[0]);
  }
}
