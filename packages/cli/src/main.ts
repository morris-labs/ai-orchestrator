#!/usr/bin/env node
// The `agentbox` command.
import { homedir } from "node:os";
import { runCli } from "./program.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  home: homedir(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  signal: controller.signal,
});
process.exitCode = code;
