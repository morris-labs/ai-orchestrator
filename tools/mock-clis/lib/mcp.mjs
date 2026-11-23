// A small MCP client over streamable HTTP, so the mock CLIs can act out the
// tool calls that a scenario response lists in `busCalls`, as a real agent
// would call the team chat bus. Each call runs the handshake
// (`initialize`, `notifications/initialized`), lists the tools, and calls
// the tool.

const PROTOCOL_VERSION = "2025-06-18";

async function post(server, body) {
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...server.headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the status says what went wrong.
  }
  return { status: res.status, json };
}

/**
 * Calls each tool in `calls` ({ server?, tool, arguments }) on the matching
 * server of `servers` ({ NAME: { url, headers } }). `allowed(server, tool)`
 * returns an error text for a call the CLI refuses on its own, or `null`.
 * Returns one result per call: { server, tool, isError, text }.
 */
export async function actOutBusCalls(servers, calls, allowed = () => null) {
  const results = [];
  const ready = new Set();
  let id = 0;
  for (const call of calls ?? []) {
    const name = call.server ?? Object.keys(servers)[0];
    const server = name === undefined ? undefined : servers[name];
    const result = { server: name ?? null, tool: call.tool, isError: true, text: "" };
    results.push(result);
    if (!server) {
      result.text = "no MCP server is configured";
      continue;
    }
    const refusal = allowed(name, call.tool);
    if (refusal) {
      result.text = refusal;
      continue;
    }
    try {
      if (!ready.has(name)) {
        const init = await post(server, {
          jsonrpc: "2.0",
          id: (id += 1),
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "mock-cli", version: "0.0.0" },
          },
        });
        if (init.status !== 200) {
          result.text = `initialize failed with HTTP ${init.status}`;
          continue;
        }
        await post(server, { jsonrpc: "2.0", method: "notifications/initialized" });
        ready.add(name);
      }
      const list = await post(server, { jsonrpc: "2.0", id: (id += 1), method: "tools/list" });
      const tools = list.json?.result?.tools?.map((t) => t.name) ?? [];
      if (!tools.includes(call.tool)) {
        result.text = `the server has no tool ${call.tool} (HTTP ${list.status})`;
        continue;
      }
      const answer = await post(server, {
        jsonrpc: "2.0",
        id: (id += 1),
        method: "tools/call",
        params: { name: call.tool, arguments: call.arguments ?? {} },
      });
      const out = answer.json?.result;
      if (answer.status !== 200 || !out) {
        result.text = answer.json?.error?.message ?? `HTTP ${answer.status}`;
        continue;
      }
      result.isError = out.isError === true;
      result.text = (out.content ?? []).map((c) => c.text ?? "").join("\n");
    } catch (err) {
      result.text = `the MCP server can't be reached: ${err?.message ?? err}`;
    }
  }
  return results;
}
