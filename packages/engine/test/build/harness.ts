// The engine build API test seam (spec #55, Testing decisions): a build
// manager over a small Node.js project, with the mock vendor CLIs from
// `tools/mock-clis` answering from a scenario file, and no server. Tests
// drive builds through the build requests and assert on what the Project
// manager can observe: build files, Git branches, events, and the calls
// that reached a vendor CLI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BUILDS_DIR,
  BuildStateSchema,
  type BuildPlanInput,
  type BuildState,
  type BuildStep,
  type Vendor,
} from "@aio/contracts";
import { bridgeAdapters } from "../../src/adapters/bridge.js";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { CopilotAdapter } from "../../src/adapters/copilot.js";
import type { CliVendorAdapter } from "../../src/adapters/types.js";
import {
  BUILD_PIPELINE,
  STEP_HANDLERS,
  createBuildManager,
  type BuildPipeline,
  type EngineBuildManager,
} from "../../src/build/index.js";
import { GrantingBroker, MemoryEventSink } from "../../src/core.js";
import type { GitHubClient } from "../../src/postpush/github.js";
import { silentLogger } from "../../src/main/logger.js";
import { TeamBus } from "../../src/team/index.js";
import { createRunManager, type EngineRunManager } from "../../src/state/manager.js";
import { MOCK_BIN } from "../adapters/helpers.js";
import { tempDir } from "../tmp.js";

/** One scripted answer of a mock CLI; see `tools/mock-clis/README.md`. */
export interface MockResponse {
  match?: string;
  times?: number;
  output?: unknown;
  writeFiles?: Record<string, string>;
  /** Commits every change after `writeFiles`, with this message. */
  commit?: string;
  error?: string;
  /** Replaces the error's default text. */
  errorMessage?: string;
  delayMs?: number;
  /** The tokens the call reports in its usage. */
  tokens?: { input: number; output: number };
  /** MCP tool calls that the mock CLI makes, such as team chat messages. */
  busCalls?: { tool: string; arguments?: Record<string, unknown>; server?: string }[];
}

/** One call that reached a mock CLI, as its log line records it. */
export interface MockCall {
  cli: string;
  prompt: string;
  argv: string[];
  /** The Codex thread a `codex exec resume` call resumed. */
  resumeId?: string | null;
}

/** The project id the build requests name. */
export const PROJECT_ID = "proj-shop";

/** The stub that the task replaces. */
export const CART_STUB = "export function total(items) {\n  return 0;\n}\n";
/** A cart module that passes the task's tests and lint. */
export const CART_DONE =
  "export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n";
/** A cart module that fails the task's test. */
export const CART_WRONG = "export function total(items) {\n  return items.length;\n}\n";

/** A Developer report with every criterion met. */
export const REPORT = {
  summary: "Added the cart total.",
  criteria: [{ id: "AC1", met: true }],
};

/** A small, one-task plan over the sample project. */
export function cartPlan(overrides: Partial<BuildPlanInput> = {}): BuildPlanInput {
  return {
    title: "Add a total to the cart",
    size: "small",
    criteria: [{ id: "AC1", text: "The cart reports the sum of its item prices." }],
    tasks: [
      {
        id: "T1",
        title: "Cart total",
        description: "Make total() return the sum of the item prices.",
        ownedFiles: ["src/cart.mjs"],
        criteria: ["AC1"],
        tests: ["test/cart.test.mjs"],
      },
    ],
    commands: {
      test: [{ command: "node test/cart.test.mjs" }],
      typecheck: [{ command: "node --check src/cart.mjs" }],
      lint: [{ command: "node lint.mjs" }],
    },
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/** A Git repository with a cart module stub, its test, and a lint script. */
function sampleProject(): string {
  const root = tempDir("aio-build-");
  const files: Record<string, string> = {
    "src/cart.mjs": CART_STUB,
    "test/cart.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { total } from "../src/cart.mjs";',
      "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
      'console.log("ok");',
      "",
    ].join("\n"),
    "lint.mjs": [
      'import { readFileSync } from "node:fs";',
      'if (readFileSync("src/cart.mjs", "utf8").includes("console.log")) {',
      '  console.error("src/cart.mjs: no console.log");',
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
    "README.md": "# Shop\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Example Owner");
  git(root, "config", "user.email", "owner@example.com");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feat: add the cart");
  return root;
}

/**
 * The steps a build world runs unless a test asks for others: the build
 * pipeline without tests first, so a scenario about a later step scripts only
 * the seats of that step. Scenarios about tests first pass `BUILD_PIPELINE`.
 */
export const WORLD_STEPS: readonly BuildStep[] = BUILD_PIPELINE.filter(
  (step) => step !== "tests_first",
);

export interface BuildWorldOptions {
  /** The steps the builds run, in order. Default: `WORLD_STEPS`. */
  steps?: readonly BuildStep[];
  /** Runs the review step. Off by default: the build then waits at that step. */
  review?: boolean;
  /** Runs the release ready step. Off by default: the build then waits at that step. */
  release?: boolean;
  /** The GitHub client of the review runs' post-push loop. Default: none, which never reaches the network. */
  github?: GitHubClient;
  /** The secret names the project gives builds. Default: none, and preflight doesn't check secrets. */
  secretNames?: () => Promise<string[]>;
  /** Adds the Copilot mock CLI to Claude and Codex. */
  copilot?: boolean;
}

/**
 * The handlers a build world runs: every step's, without the review's unless
 * `review` is set, and without the release ready step's unless `release` is.
 */
function worldPipeline(options: BuildWorldOptions): BuildPipeline {
  const skip = new Set<string>([
    ...(options.review ? [] : ["review"]),
    ...(options.release ? [] : ["release_ready"]),
  ]);
  return {
    steps: options.steps ?? WORLD_STEPS,
    handlers: Object.fromEntries(Object.entries(STEP_HANDLERS).filter(([step]) => !skip.has(step))),
  };
}

/** A GitHub client that refuses every call, so a world without a fake never reaches GitHub. */
const NO_GITHUB: GitHubClient = new Proxy({} as GitHubClient, {
  get: (_target, name) =>
    name === "then"
      ? undefined
      : () => Promise.reject(new Error(`This build world has no GitHub client (${String(name)}).`)),
});

export interface BuildWorld {
  root: string;
  manager: EngineBuildManager;
  /** The review runs that builds start. */
  runs: EngineRunManager;
  events: MemoryEventSink;
  broker: GrantingBroker;
  /** The team chat bus that the builds' seat calls reach. */
  team: TeamBus;
  /** Starts build `slug` from `plan` (default: `cartPlan()`) with the build request. */
  start(slug: string, plan?: BuildPlanInput): Promise<BuildState>;
  /** Sets the mock CLIs' answers, by vendor. */
  script(responses: Partial<Record<Vendor, MockResponse[]>>): void;
  /** The calls that reached a mock CLI, oldest first. */
  calls(): MockCall[];
  /** Closes the manager, as an engine shutdown does, and starts a new one over the same files. */
  restart(): Promise<void>;
  /** Waits until the build's state satisfies `done`. */
  waitFor(slug: string, done: (state: BuildState) => boolean, ms?: number): Promise<BuildState>;
  /** Waits until the build stops running and its last `build.changed` event shows it. */
  settle(slug: string): Promise<BuildState>;
  /** The build's directory. */
  dir(slug: string): string;
  /** A file in the build's directory, as text. */
  file(slug: string, path: string): string;
  /** The JSON files in a directory of the build's directory. */
  jsonFiles(slug: string, path: string): unknown[];
  git(cwd: string, ...args: string[]): string;
}

/** Starts a build world. Close it with `restart()` or let the test end. */
export async function buildWorld(options: BuildWorldOptions = {}): Promise<BuildWorld> {
  const root = sampleProject();
  const work = tempDir("aio-build-cli-");
  const scenario = join(work, "scenario.json");
  const log = join(work, "calls.jsonl");
  writeFileSync(scenario, "{}");
  const env = { MOCK_CLI_SCENARIO: scenario, MOCK_CLI_LOG: log, ANTHROPIC_API_KEY: undefined };
  const cliOptions = { env, account: "user@example.com" };
  const cli: Partial<Record<Vendor, CliVendorAdapter>> = {
    claude: new ClaudeAdapter({
      ...cliOptions,
      command: join(MOCK_BIN, "claude"),
      bare: false,
      persistSessions: false,
    }),
    codex: new CodexAdapter({ ...cliOptions, command: join(MOCK_BIN, "codex") }),
    // The review runs that builds start pick from every vendor, so Copilot
    // takes part only in the worlds that ask for it.
    ...(options.copilot
      ? { copilot: new CopilotAdapter({ ...cliOptions, command: join(MOCK_BIN, "copilot") }) }
      : {}),
  };
  const team = new TeamBus({ log: silentLogger });
  await team.start();
  const make = async () => {
    const events = new MemoryEventSink("engine:test", "stream-build");
    const broker = new GrantingBroker();
    const core = {
      projectRoot: root,
      container: "aio-agent-proj-build",
      events,
      leases: broker,
      adapters: bridgeAdapters(cli),
      log: silentLogger,
      github: options.github ?? NO_GITHUB,
    };
    const runs = await createRunManager(core);
    const manager = await createBuildManager({
      ...core,
      skillDirs: () => [],
      team,
      reviews: runs,
      reviewPollMs: 25,
      pipeline: worldPipeline(options),
      ...(options.secretNames ? { secretNames: options.secretNames } : {}),
    });
    return { events, broker, manager, runs };
  };
  let current = await make();
  const dir = (slug: string) => join(root, BUILDS_DIR, slug);
  const world: BuildWorld = {
    root,
    get manager() {
      return current.manager;
    },
    get events() {
      return current.events;
    },
    get broker() {
      return current.broker;
    },
    team,
    get runs() {
      return current.runs;
    },
    start(slug, plan = cartPlan()) {
      return current.manager.start({ projectId: PROJECT_ID, slug, plan });
    },
    script(responses) {
      writeFileSync(
        scenario,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(responses).map(([vendor, list]) => [vendor, { responses: list }]),
          ),
        ),
      );
    },
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as MockCall);
    },
    async restart() {
      await current.manager.close();
      await current.runs.close();
      current = await make();
    },
    async waitFor(slug, done, ms = 30_000) {
      const end = Date.now() + ms;
      let last: BuildState | null = null;
      while (Date.now() < end) {
        last = await current.manager.get(slug);
        if (last && done(last)) return BuildStateSchema.parse(last);
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`build ${slug} didn't reach the state; last: ${JSON.stringify(last)}`);
    },
    settle(slug) {
      // The build's state changes before its `build.changed` event goes out,
      // and the event reaches `events.jsonl` after the stream, so a settled
      // build is one whose last event shows the same status and whose file
      // holds every `build.changed` event the stream sent.
      return world.waitFor(slug, (s) => {
        const sent = current.events.ofType("build.changed").filter((e) => e.build.id === s.id);
        const shown = sent.at(-1)?.build;
        const file = join(dir(slug), "events.jsonl");
        const saved = existsSync(file)
          ? readFileSync(file, "utf8")
              .split("\n")
              .filter((line) => line.includes('"type":"build.changed"')).length
          : 0;
        return (
          s.status !== "running" &&
          shown?.status === s.status &&
          shown.step === s.step &&
          saved >= sent.length
        );
      });
    },
    dir,
    file(slug, path) {
      return readFileSync(join(dir(slug), path), "utf8");
    },
    jsonFiles(slug, path) {
      const at = join(dir(slug), path);
      if (!existsSync(at)) return [];
      return readdirSync(at)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => JSON.parse(readFileSync(join(at, name), "utf8")) as unknown);
    },
    git,
  };
  return world;
}
