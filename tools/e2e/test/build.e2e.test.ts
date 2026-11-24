// The build pipeline's walking skeleton (spec #55): a hand-written build
// plan with one task runs through preflight, tests first, the task, and
// the review to release ready against the real server and engine. The engine runs the vendor adapters against the mock vendor CLIs
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
const TAX_TEST = readFileSync(path.join(FIXTURES, "test_tax.py"), "utf8");
const TAX_STUB = readFileSync(path.join(FIXTURES, "tax-stub.py"), "utf8");
const TAX_DONE = readFileSync(path.join(FIXTURES, "tax.py"), "utf8");
const TAX_WRONG = readFileSync(path.join(FIXTURES, "tax-wrong.py"), "utf8");
/** The Developer's report, with every criterion met. */
const REPORT = { summary: "Added add_tax.", criteria: [{ id: "AC1", met: true }] };
/** What each scripted Developer call reports using. */
const DEVELOPER_TOKENS = { input: 3000, output: 700 };
/** What the scripted Test engineer call reports using. */
const TEST_ENGINEER_TOKENS = { input: 2000, output: 500 };

/**
 * The Test engineer's answer: it writes the task's test, which fails on an
 * assertion against the stub, so the red check passes and the engine locks it.
 */
const TEST_ENGINEER = {
  match: "round 1 of",
  output: {
    summary: "Wrote the sales tax tests first.",
    tests: [
      {
        file: "tests/test_tax.py",
        name: "AC1: add_tax adds the tax, rounded to cents",
        criterion: "AC1",
        command: "python3 -B -m unittest tests.test_tax -q",
      },
    ],
  },
  tokens: TEST_ENGINEER_TOKENS,
  writeFiles: { "tests/test_tax.py": TAX_TEST },
};

/** The Developer's answer: it writes `content` to the module. */
function developer(content: string) {
  return {
    match: "Task T1",
    output: REPORT,
    tokens: DEVELOPER_TOKENS,
    writeFiles: { "shop/tax.py": content },
  };
}

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

/** Starts a build from box `boxId`; a box runs one build at a time, so each scenario has its own. */
async function startBuild(slug: string, plan: string, boxId = "box-e2e"): Promise<BuildState> {
  const r = await runBuildCli(["start", slug, plan, "--json"], { ...buildEnv, AIO_BOX_ID: boxId });
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
    // The module starts as a stub, which the Test engineer's test fails
    // on an assertion and the Developer replaces.
    prepareRepo: (repo) => {
      copyFileSync(path.join(FIXTURES, "tax-stub.py"), path.join(repo, "shop", "tax.py"));
      git(repo, "add", "shop/tax.py");
      git(repo, "commit", "-q", "-m", "Add a sales tax stub");
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
    script({ codex: [TEST_ENGINEER], claude: [developer(TAX_DONE)] });
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
    // The plan records no push answer, so release ready stops before the push.
    expect(state).toMatchObject({ status: "waiting_escalation", step: "release_ready" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "release_ready", level: "owner" }),
    ]);
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
    const steps = new Set(seen.map((e) => (e.build as { step: string }).step));
    expect([...steps]).toEqual(["preflight", "tests_first", "tasks", "review", "release_ready"]);
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
    expect(git(stack.repo, "show", "build/sales-tax:tests/test_tax.py")).toBe(TAX_TEST.trim());
    expect(git(stack.repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(stack.repo, "shop", "tax.py"), "utf8")).toBe(TAX_STUB);
  });

  it("keeps the preflight baseline and the test lock in the build's folder", () => {
    for (const file of ["baseline.json", "test-lock.json", "tests-first/round-1.json"]) {
      expect(existsSync(path.join(buildDir("sales-tax"), file)), file).toBe(true);
    }
    const lock = JSON.parse(
      readFileSync(path.join(buildDir("sales-tax"), "test-lock.json"), "utf8"),
    ) as { files: Array<{ path: string }> };
    expect(lock.files.map((f) => f.path)).toContain("tests/test_tax.py");
  });

  it("gates the build's review run with the plan's commands", () => {
    // The project has no policy file, so these come only from the plan.
    const { runId } = JSON.parse(
      readFileSync(path.join(buildDir("sales-tax"), "review", "run.json"), "utf8"),
    ) as { runId: string };
    const preflight = JSON.parse(
      readFileSync(path.join(stack.repo, ".aio", "runs", runId, "preflight.json"), "utf8"),
    ) as { baseline: { commands: Array<{ kind: string; command: string }> } };
    expect(preflight.baseline.commands.map(({ kind, command }) => ({ kind, command }))).toEqual([
      { kind: "test", command: "python3 -B -m unittest discover -s tests -q" },
      { kind: "lint", command: "python3 -B lint.py" },
    ]);
  });

  it("writes a status file that names the step and the task", () => {
    const text = readFileSync(path.join(buildDir("sales-tax"), "STATUS.md"), "utf8");
    expect(text).toContain("Status: waiting_escalation");
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
    expect(usage.bySeat.find((s) => s.seat === "test-engineer")).toMatchObject({
      calls: 1,
      tokensIn: TEST_ENGINEER_TOKENS.input,
      tokensOut: TEST_ENGINEER_TOKENS.output,
    });
    expect(usage.byStep.find((s) => s.step === "tasks")).toMatchObject({ calls: 1 });
    expect(usage.byStep.find((s) => s.step === "tests_first")).toMatchObject({ calls: 1 });
    expect(usage.total.calls).toBeGreaterThanOrEqual(1);
  });
});

describe("the attempt cap", () => {
  it("escalates a task that fails all four attempts, and the build waits", async () => {
    script({ codex: [TEST_ENGINEER], claude: [developer(TAX_WRONG)] });
    const started = await startBuild("sales-tax-cap", planFile("sales-tax-cap"), "box-e2e-cap");

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

    // No attempt passed the gate, so the build branch stays at the commit
    // of the tests first, with the module still the stub.
    const lock = JSON.parse(
      readFileSync(path.join(buildDir("sales-tax-cap"), "test-lock.json"), "utf8"),
    ) as { commit: string };
    expect(git(stack.repo, "rev-parse", "build/sales-tax-cap")).toBe(lock.commit);
    expect(git(stack.repo, "rev-parse", `${lock.commit}~1`)).toBe(started.base);
    expect(git(stack.repo, "show", "build/sales-tax-cap:shop/tax.py")).toBe(TAX_STUB.trim());

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
    script({ codex: [TEST_ENGINEER], claude: [developer(TAX_DONE)] });
    // The test command holds the task gate while the hold file exists, once
    // the Developer has written the module: only its code calls round(),
    // while the stub's docstring says "rounded" too.
    const hold = path.join(stack.dir, "hold");
    const gateStarted = path.join(stack.dir, "gate-started");
    writeFileSync(hold, "");
    const plan = planFile("sales-tax-restart", (p) => {
      const commands = p.commands as { test: Array<{ command: string }> };
      commands.test = [
        {
          command: `if grep -qF 'round(' shop/tax.py; then touch ${gateStarted}; while [ -e ${hold} ]; do sleep 0.05; done; fi; python3 -B -m unittest discover -s tests -q`,
        },
      ];
    });
    const started = await startBuild("sales-tax-restart", plan, "box-e2e-restart");
    await waitFor("the task gate to start", () => (existsSync(gateStarted) ? true : undefined));
    expect((await status("sales-tax-restart")).status).toBe("running");
    // The hold is at the task gate, after the Developer's call, not at preflight.
    expect(developerCalls()).toBe(1);

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
    expect(state).toMatchObject({
      id: started.id,
      status: "waiting_escalation",
      step: "release_ready",
    });
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
