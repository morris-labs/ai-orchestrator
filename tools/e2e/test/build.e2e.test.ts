// The build pipeline's walking skeleton (spec #55): a hand-written build
// plan with one task runs to release ready against the real server and
// engine. The engine runs the vendor adapters against the mock vendor CLIs
// in `tools/mock-clis`, which answer from a scenario file and write the
// files a scripted Developer writes. Builds start over the engine's build
// socket with `aio-build`, as the Project manager's box session starts them.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildState, BuildUsage } from "@aio/contracts";
import { ROOT, buildCliEnv, runBuildCli, tailEvents, waitFor, type CliResult } from "./harness.js";
import { startStack, type Stack } from "./stack.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "build");
const MOCK_BIN = path.join(ROOT, "tools", "mock-clis", "bin");
const TAX_DONE = readFileSync(path.join(FIXTURES, "tax.py"), "utf8");
const TAX_WRONG = readFileSync(path.join(FIXTURES, "tax-wrong.py"), "utf8");
/** The Developer's report, with every criterion met. */
const REPORT = { summary: "Added add_tax.", criteria: [{ id: "AC1", met: true }] };
/** What each scripted Developer call reports using. */
const DEVELOPER_TOKENS = { input: 3000, output: 700 };

let stack: Stack;
let buildEnv: NodeJS.ProcessEnv = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function scenarioFile(): string {
  return path.join(stack.dir, "mock", "scenario.json");
}

/**
 * Sets the mock CLIs' answers and starts their use counts over. Every CLI
 * then answers any other prompt with no findings, so each review finds
 * nothing.
 */
function script(responses: Partial<Record<"claude" | "codex" | "copilot", unknown[]>>): void {
  const scenario = Object.fromEntries(
    (["claude", "codex", "copilot"] as const).map((cli) => [
      cli,
      { responses: [...(responses[cli] ?? []), { output: { findings: [] } }] },
    ]),
  );
  writeFileSync(scenarioFile(), JSON.stringify(scenario, null, 2));
  rmSync(`${scenarioFile()}.state.json`, { force: true });
  rmSync(path.join(stack.dir, "mock", "calls.jsonl"), { force: true });
}

/** The prompts that reached a mock CLI, oldest first. */
function calls(): Array<{ cli: string; prompt: string }> {
  const log = path.join(stack.dir, "mock", "calls.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { cli: string; prompt: string });
}

/** How many Developer calls of task T1 reached a mock CLI. */
function developerCalls(): number {
  return calls().filter((c) => c.prompt.includes("This is attempt")).length;
}

/** Writes a plan file, from the fixture plan with `change` applied. */
function planFile(slug: string, change: (plan: Record<string, unknown>) => void = () => {}) {
  const plan = JSON.parse(readFileSync(path.join(FIXTURES, "plan.json"), "utf8")) as Record<
    string,
    unknown
  >;
  change(plan);
  const file = path.join(stack.dir, `${slug}.plan.json`);
  writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

async function aioBuild(...args: string[]): Promise<CliResult> {
  return runBuildCli(args, buildEnv);
}

async function startBuild(slug: string, plan: string): Promise<BuildState> {
  const r = await aioBuild("start", slug, plan, "--json");
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as BuildState;
}

async function status(slug: string): Promise<BuildState> {
  const r = await aioBuild("status", slug, "--json");
  if (r.code !== 0) throw new Error(`aio-build status ${slug} exited ${r.code}: ${r.stderr}`);
  return JSON.parse(r.stdout) as BuildState;
}

/** Waits until build `slug` stops running and returns its state. */
function settle(slug: string, timeoutMs = 45_000): Promise<BuildState> {
  return waitFor(
    `build ${slug} to stop running`,
    async () => {
      const state = await status(slug);
      return state.status === "running" ? undefined : state;
    },
    timeoutMs,
  );
}

function buildDir(slug: string): string {
  return path.join(stack.repo, ".aio", "builds", slug);
}

function buildEvents(slug: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(buildDir(slug), "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(async () => {
  stack = await startStack({
    // The adapters run the mock CLIs, each with a configuration folder of
    // its own, so no call reads or writes a real vendor folder.
    engineEnv: (dir) => {
      const mock = path.join(dir, "mock");
      const homes = Object.fromEntries(
        ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME"].map((name) => {
          const folder = path.join(mock, name.toLowerCase());
          mkdirSync(folder, { recursive: true });
          return [name, folder];
        }),
      );
      writeFileSync(path.join(mock, "scenario.json"), "{}");
      return {
        ...homes,
        PATH: `${MOCK_BIN}${path.delimiter}${process.env.PATH ?? ""}`,
        MOCK_CLI_SCENARIO: path.join(mock, "scenario.json"),
        MOCK_CLI_LOG: path.join(mock, "calls.jsonl"),
      };
    },
    // The task's test comes first, so it fails until the Developer adds
    // the module it tests.
    prepareRepo: (repo) => {
      copyFileSync(path.join(FIXTURES, "test_tax.py"), path.join(repo, "tests", "test_tax.py"));
      git(repo, "add", "tests/test_tax.py");
      git(repo, "commit", "-q", "-m", "Add the sales tax test");
    },
  });
  await stack.api("POST", "/projects", { root: stack.repo });
  buildEnv = buildCliEnv(path.join(stack.stateDir, "build.sock"), stack.projectId);
});

afterAll(() => {
  stack?.close();
});

describe("a one-task build", () => {
  let state: BuildState;

  it("runs from aio-build start to release ready", async () => {
    script({
      claude: [
        {
          match: "Task T1",
          output: REPORT,
          tokens: DEVELOPER_TOKENS,
          writeFiles: { "shop/tax.py": TAX_DONE },
        },
      ],
    });
    const tail = tailEvents(["--types", "build.changed,build.task.changed"], stack.cliEnv);
    await tail.connected;

    const started = await startBuild("sales-tax", planFile("sales-tax"));
    expect(started).toMatchObject({
      slug: "sales-tax",
      projectId: stack.projectId,
      boxId: "box-e2e",
      branch: "build/sales-tax",
      status: "running",
    });

    state = await settle("sales-tax");
    expect(state).toMatchObject({ status: "paused", step: "release_ready" });
    expect(state.tasks).toEqual([
      expect.objectContaining({ id: "T1", status: "done", attempts: 1 }),
    ]);
    expect(developerCalls()).toBe(1);

    // The server relays the build's events to clients.
    const seen = await waitFor("the release-ready build.changed event", () => {
      const events = tail.lines().filter((l) => l.type === "build.changed");
      return events.some((e) => (e.build as { step: string }).step === "release_ready")
        ? events
        : undefined;
    });
    tail.child.kill("SIGTERM");
    expect(seen.map((e) => (e.build as { step: string }).step)).toContain("tasks");
    expect(tail.lines()).toContainEqual(
      expect.objectContaining({
        type: "build.task.changed",
        buildId: state.id,
        taskId: "T1",
        status: "done",
      }),
    );
  });

  it("commits the task's work on the build branch and leaves the project's checkout alone", () => {
    expect(git(stack.repo, "show", "build/sales-tax:shop/tax.py")).toBe(TAX_DONE.trim());
    expect(git(stack.repo, "merge-base", "--is-ancestor", state.base, "build/sales-tax")).toBe("");
    expect(git(stack.repo, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(stack.repo, "shop", "tax.py"))).toBe(false);
  });

  it("writes a status file that names the step and the task", () => {
    const text = readFileSync(path.join(buildDir("sales-tax"), "STATUS.md"), "utf8");
    expect(text).toContain("Status: paused");
    expect(text).toContain("release_ready");
    expect(text).toContain("T1");
  });

  it("records the build's events, and the server mirrors the build", () => {
    const events = buildEvents("sales-tax");
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("build.changed");
    expect(types).toContain("build.task.changed");
    const developer = events.find((e) => e.type === "agent.started" && e.seat === "developer");
    expect(developer).toMatchObject({ runId: null, buildId: state.id, step: "tasks" });

    const d = stack.db();
    try {
      const row = d.prepare("SELECT * FROM svc_builds WHERE id = ?").get(state.id);
      expect(row).toMatchObject({ project_id: stack.projectId });
    } finally {
      d.close();
    }
  });

  it("reports the build's usage by seat through the server", async () => {
    const usage = (await stack.api("GET", `/builds/${state.id}/usage`)) as BuildUsage;
    const developer = usage.bySeat.find((s) => s.seat === "developer");
    expect(developer).toMatchObject({
      calls: 1,
      tokensIn: DEVELOPER_TOKENS.input,
      tokensOut: DEVELOPER_TOKENS.output,
    });
    expect(usage.byStep.find((s) => s.step === "tasks")).toMatchObject({ calls: 1 });
    expect(usage.total.calls).toBeGreaterThanOrEqual(1);
  });
});

describe("the attempt cap", () => {
  it("escalates a task that fails all four attempts, and the build waits", async () => {
    script({
      claude: [
        {
          match: "Task T1",
          output: REPORT,
          tokens: DEVELOPER_TOKENS,
          writeFiles: { "shop/tax.py": TAX_WRONG },
        },
      ],
    });
    const started = await startBuild("sales-tax-cap", planFile("sales-tax-cap"));

    const state = await settle("sales-tax-cap");
    expect(state).toMatchObject({ status: "waiting_escalation", step: "tasks" });
    expect(state.tasks).toEqual([
      expect.objectContaining({ id: "T1", status: "failed", attempts: 4 }),
    ]);
    expect(developerCalls()).toBe(4);
    expect(state.escalations).toEqual([
      expect.objectContaining({
        id: "E1",
        kind: "attempt_cap",
        level: "project_manager",
        taskId: "T1",
        file: "escalations/E1.json",
      }),
    ]);

    const escalation = JSON.parse(
      readFileSync(path.join(buildDir("sales-tax-cap"), "escalations", "E1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(escalation).toMatchObject({ id: "E1", kind: "attempt_cap", taskId: "T1" });
    expect(escalation.details).toContain("python3 -B -m unittest discover -s tests -q");

    const text = readFileSync(path.join(buildDir("sales-tax-cap"), "STATUS.md"), "utf8");
    expect(text).toContain("waiting_escalation");
    expect(text).toContain("escalations/E1.json");
    const human = await aioBuild("status", "sales-tax-cap");
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("E1");

    // No attempt passed the gate, so the build branch stays at its base.
    expect(git(stack.repo, "rev-parse", "build/sales-tax-cap")).toBe(started.base);

    const usage = (await stack.api("GET", `/builds/${state.id}/usage`)) as BuildUsage;
    expect(usage.bySeat.find((s) => s.seat === "developer")).toMatchObject({
      calls: 4,
      tokensIn: 4 * DEVELOPER_TOKENS.input,
    });
    await waitFor("the server to mirror the waiting build", () => {
      const d = stack.db();
      try {
        const row = d.prepare("SELECT status FROM svc_builds WHERE id = ?").get(state.id) as
          { status: string } | undefined;
        return row?.status === "waiting_escalation" ? true : undefined;
      } finally {
        d.close();
      }
    });
  });
});

describe("an engine restart mid-build", () => {
  it("continues the build in the new engine without repeating the agent call", async () => {
    script({
      claude: [
        {
          match: "Task T1",
          output: REPORT,
          tokens: DEVELOPER_TOKENS,
          writeFiles: { "shop/tax.py": TAX_DONE },
        },
      ],
    });
    // The test command holds the task gate while the hold file exists, once
    // the Developer has written the module.
    const hold = path.join(stack.dir, "hold");
    const gateStarted = path.join(stack.dir, "gate-started");
    writeFileSync(hold, "");
    const plan = planFile("sales-tax-restart", (p) => {
      const commands = p.commands as { test: Array<{ command: string }> };
      commands.test = [
        {
          command: `if [ -e shop/tax.py ]; then touch ${gateStarted}; while [ -e ${hold} ]; do sleep 0.05; done; fi; python3 -B -m unittest discover -s tests -q`,
        },
      ];
    });
    const started = await startBuild("sales-tax-restart", plan);
    await waitFor("the task gate to start", () => (existsSync(gateStarted) ? true : undefined));
    expect((await status("sales-tax-restart")).status).toBe("running");

    rmSync(gateStarted);
    await stack.restartEngine();
    // The new engine continues the build: it reuses the saved Developer
    // answer and runs the task gate again.
    await waitFor("the new engine to run the task gate", () =>
      existsSync(gateStarted) ? true : undefined,
    );
    expect(stack.engine().output()).toContain("Continuing a build the engine left unfinished");
    rmSync(hold);

    const state = await settle("sales-tax-restart");
    expect(state).toMatchObject({ id: started.id, status: "paused", step: "release_ready" });
    expect(state.tasks).toEqual([
      expect.objectContaining({ id: "T1", status: "done", attempts: 1 }),
    ]);
    expect(developerCalls()).toBe(1);
    expect(git(stack.repo, "show", "build/sales-tax-restart:shop/tax.py")).toBe(TAX_DONE.trim());

    // The server follows the build through the new engine's events.
    await waitFor("the server to mirror the release-ready build", () => {
      const d = stack.db();
      try {
        const row = d.prepare("SELECT json FROM svc_builds WHERE id = ?").get(state.id) as
          { json: string } | undefined;
        const build = row ? (JSON.parse(row.json) as { step: string | null }) : undefined;
        return build?.step === "release_ready" ? true : undefined;
      } finally {
        d.close();
      }
    });
    const usage = (await stack.api("GET", `/builds/${state.id}/usage`)) as BuildUsage;
    expect(usage.bySeat.find((s) => s.seat === "developer")).toMatchObject({ calls: 1 });
  });
});
