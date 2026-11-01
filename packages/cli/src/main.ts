#!/usr/bin/env node
// The `aio` command.
import { homedir } from "node:os";
import { hostOsFrom } from "@aio/contracts";
import { runCli } from "./program.js";

// A SIGINT listener stops Node.js from exiting on Ctrl+C, so every command
// honors the signal: `events` ends cleanly, and the others stop their
// request or job polling and exit 130. A second Ctrl+C exits at once.
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  home: homedir(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  signal: controller.signal,
  hostOs: hostOsFrom(process.platform),
});
process.exitCode = code;
