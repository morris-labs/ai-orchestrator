#!/usr/bin/env node
// The `agentbox-engine` entry point, started by the container's keeper.
import { main } from "./main/run.js";

const code = await main(process.argv.slice(2), process.env);
process.exit(code);
