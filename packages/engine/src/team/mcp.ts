// A small Model Context Protocol server: the JSON-RPC methods of the tools
// feature, answered with plain JSON over streamable HTTP. It has no
// sessions, no server-sent event streams, and no other features, which is
// all the team chat needs and all that Claude Code and Codex use of it.
// See https://modelcontextprotocol.io/specification/2025-06-18/basic/transports.

/** Protocol versions the server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** What a tool returns: text for the model, and optionally a JSON object. */
export interface McpToolResult {
  text: string;
  structured?: Record<string, unknown>;
  /** True when the call failed; the model reads `text` to learn why. */
  isError?: boolean;
}

/** One tool, called on behalf of `Caller`, the identity the transport proved. */
export interface McpTool<Caller> {
  name: string;
  description: string;
  /** The JSON Schema of the tool's arguments. */
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  call(caller: Caller, args: unknown): Promise<McpToolResult>;
}

export interface McpServerInfo<Caller> {
  name: string;
  version: string;
  /** Text that the client may show the model about the server. */
  instructions?: string;
  tools: readonly McpTool<Caller>[];
}

/** JSON-RPC error codes. */
export const JSONRPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

type Id = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON-RPC error response. */
export function rpcError(id: Id, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Answers one JSON-RPC message from `caller`. Returns `null` for a
 * notification or a response, which get no answer.
 */
export async function handleMcpMessage<Caller>(
  message: unknown,
  caller: Caller,
  server: McpServerInfo<Caller>,
): Promise<JsonRpcResponse | null> {
  if (!isRecord(message) || message.jsonrpc !== "2.0") {
    return rpcError(null, JSONRPC_ERRORS.invalidRequest, "Send a JSON-RPC 2.0 message.");
  }
  const hasId = "id" in message && message.id !== undefined;
  // A response to a request the server never sends, or a notification such
  // as `notifications/initialized`: nothing to answer.
  if (typeof message.method !== "string") return null;
  if (!hasId) return null;
  const id = message.id as Id;
  const params = isRecord(message.params) ? message.params : {};
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

  switch (message.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version = MCP_PROTOCOL_VERSIONS.find((v) => v === asked) ?? MCP_PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: server.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      });
    case "tools/call": {
      const tool = server.tools.find((t) => t.name === params.name);
      if (!tool) {
        return rpcError(id, JSONRPC_ERRORS.invalidParams, `No tool ${String(params.name)}.`);
      }
      const result = await tool.call(caller, params.arguments ?? {});
      return ok({
        content: [{ type: "text", text: result.text }],
        ...(result.structured ? { structuredContent: result.structured } : {}),
        isError: result.isError === true,
      });
    }
    default:
      return rpcError(id, JSONRPC_ERRORS.methodNotFound, `No method ${message.method}.`);
  }
}
