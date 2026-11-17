// A core over a temporary home, an in-memory database, and the in-memory
// Docker double. Every test gets its own.
import fs from "node:fs";
import path from "node:path";
import { EventSchema } from "@aio/contracts";
import { createServerCore, type ServerCore } from "../../src/core.js";
import type { CoreEventPayload } from "../../src/records/events.js";
import type { HostEnv } from "../../src/records/env.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import { tempDir } from "../tmp.js";

export const ENGINE_VERSION = "1.0.0-test";

export interface Harness {
  home: string;
  env: HostEnv;
  docker: MemoryDocker;
  core: ServerCore;
  events: CoreEventPayload[];
  /** A fresh directory under the temporary home. */
  dir(...parts: string[]): string;
  /** Writes a transcript file for `uuid` in `workDir`. */
  transcript(workDir: string, uuid: string, lines?: object[]): string;
}

/** Validates a core payload against the full contract event schema. */
export function assertContractEvent(payload: CoreEventPayload): void {
  EventSchema.parse({
    ...payload,
    id: "evt-1",
    time: "2026-10-28T09:00:00Z",
    source: "server",
    streamId: "s1",
    seq: 1,
    sourceSeq: 1,
  });
}

export function makeHarness(
  options: {
    image?: boolean;
    engineLabel?: string;
    log?: (message: string) => void;
    accounts?: boolean;
  } = {},
): Harness {
  const home = fs.realpathSync(tempDir("aio-core-"));
  const env: HostEnv = { home, user: "tester", now: () => new Date() };
  const docker = new MemoryDocker();
  if (options.image ?? true) {
    docker.addImage("aio-agent", {
      "aio.engine-version": options.engineLabel ?? ENGINE_VERSION,
    });
  }
  let nextPort = 41000;
  const core = createServerCore({
    engineVersion: ENGINE_VERSION,
    env,
    dbPath: ":memory:",
    accountTempDirs: [],
    docker,
    allocatePort: async (exclude) => {
      while (exclude.has(nextPort)) nextPort += 1;
      return nextPort++;
    },
    portFree: async () => true,
    removalTimeoutMs: 300,
    sessionGoneTimeoutMs: 300,
    log: options.log,
  });
  if (options.accounts ?? true) {
    for (const vendor of ["claude", "codex", "copilot"] as const)
      core.accounts.create({ vendor, name: "fixture", overflow: false });
    core.settings.patch({ accountsMode: "accounts" });
  }
  const events: CoreEventPayload[] = [];
  core.events.subscribe((e) => events.push(e));
  return {
    home,
    env,
    docker,
    core,
    events,
    dir(...parts) {
      const d = path.join(home, ...parts);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
    transcript(workDir, uuid, lines) {
      const file = core.catalog.transcriptPath(workDir, uuid);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const body = lines ?? [
        { type: "user", message: { role: "user", content: "Hello there" }, sessionId: uuid },
        {
          type: "assistant",
          message: { role: "assistant", model: "claude-opus-5-5" },
          requestedModel: "claude-opus-5-5",
          effort: "high",
        },
      ];
      fs.writeFileSync(file, body.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return file;
    },
  };
}
