#!/usr/bin/env node
// A minimal WebSocket client for host-checks.sh that reads the server token
// from a file, so the token never appears in a process's argument list.
//
// Usage: node ws-client.mjs [--binary] TOKEN_FILE URL
//
// The client sends each chunk of standard input as one message, as binary
// frames with --binary and as text otherwise, and writes every message it
// receives to standard output. It exits when the server closes the socket.
// It needs Node.js 22 or later, whose built-in WebSocket accepts headers.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const binary = args[0] === "--binary";
if (binary) args.shift();
const [tokenFile, url] = args;
if (!tokenFile || !url) {
  console.error("Usage: node ws-client.mjs [--binary] TOKEN_FILE URL");
  process.exit(2);
}

const token = readFileSync(tokenFile, "utf8").trim();
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
ws.binaryType = "arraybuffer";

ws.addEventListener("open", () => {
  process.stdin.on("data", (chunk) => ws.send(binary ? chunk : chunk.toString("utf8")));
  process.stdin.on("end", () => ws.close());
});
ws.addEventListener("message", (event) => {
  const data = event.data;
  process.stdout.write(typeof data === "string" ? `${data}\n` : Buffer.from(data));
});
ws.addEventListener("close", (event) => {
  console.error(`closed: ${event.code} ${event.reason}`);
  process.exit(event.code === 1000 ? 0 : 1);
});
ws.addEventListener("error", (event) => {
  console.error(`error: ${event.message ?? "WebSocket error"}`);
});
