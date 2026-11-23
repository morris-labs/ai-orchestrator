// A build plan with three tasks (spec #55, ticket #69): tests first writes
// every task's tests red, and the engine runs the tasks one at a time in
// dependency order against the real server and engine. Each task gate runs
// the whole test suite with the later tasks' tests set aside, plus the
// tests that earlier tasks made pass. The vendor adapters run the mock
// vendor CLIs in `tools/mock-clis`.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildState } from "@aio/contracts";
import { ROOT, buildCliEnv, runBuildCli, waitFor } from "./harness.js";
import { startStack, type Stack } from "./stack.js";

const MOCK_BIN = path.join(ROOT, "tools", "mock-clis", "bin");

/** A Python module, as lines. */
const py = (...lines: string[]) => [...lines, ""].join("\n");

const STUBS = {
  "shop/tax.py": py('"""Sales tax."""', "", "", "def add_tax(price, rate):", "    return price"),
  "shop/shipping.py": py('"""Shipping."""', "", "", "def shipping(subtotal):", "    return 0"),
  "shop/checkout.py": py('"""Checkout."""', "", "", "def checkout(price):", "    return 0"),
};

const DONE = {
  T1: {
    "shop/tax.py": py(
      '"""Sales tax."""',
      "",
      "",
      "def add_tax(price, rate):",
      "    return round(price * (1 + rate), 2)",
    ),
  },
  T2: {
    "shop/shipping.py": py(
      '"""Shipping."""',
      "",
      "",
      "def shipping(subtotal):",
      "    return 0 if subtotal >= 50 else 5",
    ),
  },
  T3: {
    "shop/checkout.py": py(
      '"""Checkout."""',
      "from shop.shipping import shipping",
      "from shop.tax import add_tax",
      "",
      "",
      "def checkout(price):",
      "    taxed = add_tax(price, 0.08)",
      "    return round(taxed + shipping(taxed), 2)",
    ),
  },
};

/** A unittest module for criterion `id` that asserts `call` equals `expected`. */
function unitTest(id: string, module: string, name: string, call: string, expected: string) {
  return py(
    `# ${id}: ${name}.`,
    "import unittest",
    "",
    `from shop.${module} import ${call.split("(")[0]}`,
    "",
    "",
    `class ${module[0]?.toUpperCase()}${module.slice(1)}Test(unittest.TestCase):`,
    `    def test_${module}(self):`,
    `        self.assertEqual(${call}, ${expected})`,
  );
}

const TESTS = [
  {
    id: "AC1",
    module: "tax",
    name: "add_tax adds the tax",
    call: "add_tax(20.00, 0.08)",
    expected: "21.6",
  },
  {
    id: "AC2",
    module: "shipping",
    name: "small orders pay shipping",
    call: "shipping(10)",
    expected: "5",
  },
  {
    id: "AC3",
    module: "checkout",
    name: "checkout adds tax and shipping",
    call: "checkout(10)",
    expected: "15.8",
  },
];

/** The Test engineer writes every task's test, each red against its stub. */
const TEST_ENGINEER = {
  match: "round 1 of",
  output: {
    summary: "Wrote the tests first.",
    tests: TESTS.map((t) => ({
      file: `tests/test_${t.module}.py`,
      name: `${t.id}: ${t.name}`,
      criterion: t.id,
      command: `python3 -B -m unittest tests.test_${t.module} -q`,
    })),
  },
  writeFiles: Object.fromEntries(
    TESTS.map((t) => [
      `tests/test_${t.module}.py`,
      unitTest(t.id, t.module, t.name, t.call, t.expected),
    ]),
  ),
};

const developer = (id: keyof typeof DONE, criterion: string) => ({
  match: `Task ${id}:`,
  times: 1,
  output: { summary: `Did ${id}.`, criteria: [{ id: criterion, met: true }] },
  writeFiles: DONE[id],
});

const task = (id: string, criterion: string, module: string, dependsOn: string[]) => ({
  id,
  title: `The ${module} module`,
  description: `Implement shop/${module}.py so that its test passes.`,
  ownedFiles: [`shop/${module}.py`],
  criteria: [criterion],
  tests: [`tests/test_${module}.py`],
  dependsOn,
});

/** The plan lists the tasks out of order; checkout needs shipping, which needs tax. */
const PLAN = {
  title: "Checkout with tax and shipping",
  // A small build skips the coverage check.
  size: "small",
  criteria: TESTS.map((t) => ({ id: t.id, text: `${t.name}.` })),
  tasks: [
    task("T3", "AC3", "checkout", ["T2"]),
    task("T2", "AC2", "shipping", ["T1"]),
    task("T1", "AC1", "tax", []),
  ],
  commands: {
    test: [{ command: "python3 -B -m unittest discover -s tests -q" }],
    lint: [{ command: "python3 -B lint.py" }],
  },
};

let stack: Stack;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
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
      // Every CLI answers any other prompt with no findings, so the review finds nothing.
      const fallback = { responses: [{ output: { findings: [] } }] };
      const scenario = {
        codex: { responses: [TEST_ENGINEER, ...fallback.responses] },
        claude: {
          responses: [
            developer("T1", "AC1"),
            developer("T2", "AC2"),
            developer("T3", "AC3"),
            ...fallback.responses,
          ],
        },
        copilot: fallback,
      };
      writeFileSync(path.join(mock, "scenario.json"), JSON.stringify(scenario, null, 2));
      return {
        ...homes,
        PATH: `${MOCK_BIN}${path.delimiter}${process.env.PATH ?? ""}`,
        MOCK_CLI_SCENARIO: path.join(mock, "scenario.json"),
        MOCK_CLI_LOG: path.join(mock, "calls.jsonl"),
      };
    },
    prepareRepo: (repo) => {
      for (const [file, content] of Object.entries(STUBS)) {
        writeFileSync(path.join(repo, file), content);
      }
      git(repo, "add", "shop");
      git(repo, "commit", "-q", "-m", "Add the checkout stubs");
    },
  });
  await stack.api("POST", "/projects", { root: stack.repo });
});

afterAll(() => {
  stack?.close();
});

describe("a three-task build", () => {
  let state: BuildState;
  const slug = "checkout";
  const buildDir = () => path.join(stack.repo, ".aio", "builds", slug);

  it("runs the tasks in dependency order to release ready", async () => {
    const env = buildCliEnv(path.join(stack.stateDir, "build.sock"), stack.projectId);
    const planFile = path.join(stack.dir, `${slug}.plan.json`);
    writeFileSync(planFile, JSON.stringify(PLAN, null, 2));
    const started = await runBuildCli(["start", slug, planFile, "--json"], env);
    expect(started.code, started.stderr).toBe(0);

    state = await waitFor(
      `build ${slug} to stop running`,
      async () => {
        const r = await runBuildCli(["status", slug, "--json"], env);
        const s = JSON.parse(r.stdout) as BuildState;
        return s.status === "running" ? undefined : s;
      },
      90_000,
    );
    // The plan records no push answer, so release ready stops before the push.
    expect(state).toMatchObject({ status: "waiting_escalation", step: "release_ready" });
    expect(state.escalations).toEqual([expect.objectContaining({ kind: "release_ready" })]);
    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T3", "done", 1],
      ["T2", "done", 1],
      ["T1", "done", 1],
    ]);
    const developers = readFileSync(path.join(stack.dir, "mock", "calls.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes("This is attempt"))
      .map((l) => /Task (T\d):/.exec((JSON.parse(l) as { prompt: string }).prompt)?.[1]);
    expect(developers).toEqual(["T1", "T2", "T3"]);
  }, 120_000);

  it("commits each task on the build branch in dependency order", () => {
    const subjects = git(
      stack.repo,
      "log",
      "--reverse",
      "--format=%s",
      `${state.base}..build/${slug}`,
    );
    expect(subjects.split("\n").filter((s) => s.includes("finish task"))).toEqual([
      "chore(build): finish task T1, The tax module",
      "chore(build): finish task T2, The shipping module",
      "chore(build): finish task T3, The checkout module",
    ]);
    expect(git(stack.repo, "show", `build/${slug}:shop/checkout.py`)).toBe(
      DONE.T3["shop/checkout.py"].trim(),
    );
  });

  it("set the later tasks' tests aside in the first gate and ran the earlier tasks' tests in the last", () => {
    const gate = (id: string) =>
      (
        JSON.parse(readFileSync(path.join(buildDir(), "tasks", id, "attempt-1.json"), "utf8")) as {
          gate: { setAside?: string[]; commands: { command: string; passed: boolean }[] };
        }
      ).gate;
    expect(gate("T1").setAside).toEqual(["tests/test_checkout.py", "tests/test_shipping.py"]);
    expect(gate("T3").setAside).toBeUndefined();
    expect(gate("T3").commands.map((c) => [c.command, c.passed])).toEqual(
      expect.arrayContaining([
        ["python3 -B -m unittest tests.test_tax -q", true],
        ["python3 -B -m unittest tests.test_shipping -q", true],
      ]),
    );
  });

  it("shows each task's state and dependencies in the status file", () => {
    const text = readFileSync(path.join(buildDir(), "STATUS.md"), "utf8");
    expect(text).toMatch(/\| T3 \| The checkout module \| T2 \| done \| 1 \|/);
    expect(text).toMatch(/\| T2 \| The shipping module \| T1 \| done \| 1 \|/);
    expect(text).toMatch(/\| T1 \| The tax module \| {2}\| done \| 1 \|/);
  });
});
