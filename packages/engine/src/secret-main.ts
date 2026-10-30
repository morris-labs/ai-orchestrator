#!/usr/bin/env node
// The `agentbox-secret` entry point. See `src/secrets/cli.ts`.
import { secretMain } from "./secrets/cli.js";

const code = await secretMain(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
});
process.exitCode = code;
