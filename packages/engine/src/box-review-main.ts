#!/usr/bin/env node
// The `aio-box-review` entry point. See `src/box-review/cli.ts`.
import { boxReviewMain } from "./box-review/cli.js";

const code = await boxReviewMain(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
});
process.exitCode = code;
