#!/usr/bin/env node
// The `aio-build` entry point. See `src/build-socket/cli.ts`.
import { buildMain } from "./build-socket/cli.js";

const code = await buildMain(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
});
process.exitCode = code;
