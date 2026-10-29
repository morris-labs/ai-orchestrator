#!/usr/bin/env node
// Stands in for the server's side of the lease protocol in a smoke test: it
// subscribes to the engine's event stream, grants every lease request on the
// vendor asked for, and prints each event type it sees.
//
// Usage: node lease-granter.mjs PORT TOKEN_FILE
// TOKEN_FILE holds the engine token, as the engine's own token file does; the
// token is never printed and never passes through the environment or argv.
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const [port, tokenFile] = process.argv.slice(2);
const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
if (!port || !token) {
  console.error("Usage: node lease-granter.mjs PORT TOKEN_FILE");
  process.exit(2);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
  headers: { authorization: `Bearer ${token}` },
});
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null })));
ws.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  if (frame.type === "lease.request") {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const response = {
      decision: "granted",
      leaseId: frame.leaseId,
      vendor: frame.vendor,
      redirectedFrom: null,
      expiresAt,
    };
    ws.send(JSON.stringify({ type: "lease.response", response }));
    console.log(`granted ${frame.leaseId} ${frame.vendor} ${frame.role}`);
    return;
  }
  const detail = frame.type === "run.changed" ? ` ${frame.run.status} ${frame.run.stage}` : "";
  console.log(`${frame.type}${detail}`);
});
ws.on("close", () => process.exit(0));
ws.on("error", (err) => {
  console.error(`event socket error: ${err.message}`);
  process.exit(1);
});
