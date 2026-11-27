// The reliability gate of phase 2 (spec #95, issue #103): a medium build
// shaped like the T2 measurement runs from planning to release ready with no
// help. The Project manager plans it with the Analyst, the Architect, and one
// Critic meeting, freezes the plan, and starts it. The build then writes its
// contracts, writes and locks the tests first, runs four dependent tasks
// that share a contract file, settles a test dispute and retries a failed
// task gate on the way, reviews its diff, and reaches release ready. No
// escalation is raised, so none has the `engine defect` cause, and the build
// manager never restarts.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildPlanningSchema } from "@aio/contracts";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import { PROJECT_ID, buildWorld, type BuildWorld, type MockResponse } from "./harness.js";

const SLUG = "checkout";
const BOX = "box-pm";

/** The time the whole scenario may take, inside the suite's test timeout. */
const BUDGET_MS = 50_000;

// The code: a shared pricing contract, and three modules that build on it.
const PRICING = "src/pricing.mjs";
const CART = "src/cart.mjs";
const DISCOUNT = "src/discount.mjs";
const RECEIPT = "src/receipt.mjs";

const PRICING_STUB = "export function lineTotal(item) {\n  return 0;\n}\n";
const PRICING_DONE =
  "export function lineTotal(item) {\n  return item.price * (item.quantity ?? 1);\n}\n";
const CART_DONE = [
  'import { lineTotal } from "./pricing.mjs";',
  "export function total(items) {",
  "  return items.reduce((sum, item) => sum + lineTotal(item), 0);",
  "}",
  "",
].join("\n");
/** A cart total that counts the items, which fails the cart test. */
const CART_WRONG = "export function total(items) {\n  return items.length;\n}\n";
const DISCOUNT_STUB = "export function discount(total, code) {\n  return total;\n}\n";
const DISCOUNT_DONE =
  'export function discount(total, code) {\n  return code === "SAVE10" ? (total * 90) / 100 : total;\n}\n';
const RECEIPT_STUB = 'export function receipt(items) {\n  return "";\n}\n';
const RECEIPT_DONE = [
  'import { total } from "./cart.mjs";',
  "export function receipt(items) {",
  "  return `Total: ${total(items)}`;",
  "}",
  "",
].join("\n");

// The tests: each one fails on an assertion against the stubs.
function testFile(criterion: string, module: string, names: string, assertion: string): string {
  return [
    `// ${criterion}`,
    'import assert from "node:assert/strict";',
    `import { ${names} } from "../src/${module}.mjs";`,
    assertion,
    "",
  ].join("\n");
}

const TESTS: Record<string, string> = {
  "test/pricing.test.mjs": testFile(
    "AC1: a line costs its price times its quantity.",
    "pricing",
    "lineTotal",
    "assert.equal(lineTotal({ price: 2, quantity: 3 }), 6);",
  ),
  "test/cart.test.mjs": testFile(
    "AC2: the cart totals its lines.",
    "cart",
    "total",
    "assert.equal(total([{ price: 2 }, { price: 3, quantity: 2 }]), 8);",
  ),
  "test/receipt.test.mjs": testFile(
    "AC4: the receipt shows the cart total.",
    "receipt",
    "receipt",
    'assert.equal(receipt([{ price: 2 }, { price: 3 }]), "Total: 5");',
  ),
};
const DISCOUNT_TEST = "test/discount.test.mjs";
/** The right discount test: SAVE10 takes 10 percent off. */
const DISCOUNT_RIGHT = testFile(
  "AC3: the code SAVE10 takes 10 percent off the total.",
  "discount",
  "discount",
  'assert.equal(discount(20, "SAVE10"), 18);',
);
/** The discount test as the Test engineer first locks it: it takes 20 percent off. */
const DISCOUNT_WRONG = DISCOUNT_RIGHT.replace("), 18);", "), 16);");

const CRITERIA = [
  {
    id: "AC1",
    text: "A line costs its price times its quantity, with a quantity of 1 by default.",
  },
  { id: "AC2", text: "The cart totals the cost of its lines." },
  { id: "AC3", text: "The discount code SAVE10 takes 10 percent off the cart total." },
  { id: "AC4", text: "The receipt shows the cart total." },
];

/** What the Analyst answers: a medium spec with four tested criteria. */
const SPEC = {
  title: "Price the cart with discounts and a receipt",
  summary: "Shoppers see line costs, a total, a discount, and a receipt.",
  stories: ["As a shopper, I want my cart priced, so that I know what I pay."],
  edgeCases: ["A line without a quantity counts once."],
  criteria: CRITERIA.map((c) => ({ ...c, verification: "test" })),
  size: "medium",
  usageEstimate: { low: 1_000_000, high: 4_000_000 },
  secrets: [],
  services: [],
  recommendation: {
    flow: "single_session",
    highRisk: false,
    reason: "The change stays in the cart module and touches no stored data.",
  },
};

const task = (
  id: string,
  title: string,
  module: string,
  criterion: string,
  extra: { contracts: string[]; dependsOn?: string[] },
) => ({
  id,
  title,
  description: `Implement src/${module}.mjs for ${criterion}.`,
  // As in T2, each task owns its test file too.
  ownedFiles: [`src/${module}.mjs`, `test/${module}.test.mjs`],
  criteria: [criterion],
  tests: [`test/${module}.test.mjs`],
  specialties: [],
  dependsOn: [],
  ...extra,
});

/**
 * What the Architect answers: four tasks that share the pricing contract,
 * which T1 owns and the later tasks list as a contract, as in T2.
 */
const DESIGN = {
  architecture:
    "`lineTotal()` in src/pricing.mjs prices one line. The cart sums the lines, the discount applies to the total, and the receipt prints it.",
  sharedFiles: [PRICING],
  milestones: [
    {
      id: "M1",
      title: "Priced cart",
      goal: "The cart is priced.",
      tasks: ["T1", "T2", "T3", "T4"],
    },
  ],
  tasks: [
    task("T1", "Line cost", "pricing", "AC1", { contracts: [PRICING] }),
    task("T2", "Cart total", "cart", "AC2", { contracts: [PRICING], dependsOn: ["T1"] }),
    task("T3", "Discount code", "discount", "AC3", {
      contracts: [PRICING, DISCOUNT],
      dependsOn: ["T2"],
    }),
    task("T4", "Receipt", "receipt", "AC4", {
      contracts: [PRICING, RECEIPT],
      dependsOn: ["T2"],
    }),
  ],
};

/** The Critic's one reply: a minor point, so the meeting agrees after one round. */
const CRITIC_REPLY = {
  position: "concern",
  summary: "The design holds.",
  points: [{ severity: "minor", point: "Name the rounding rule.", reason: "Prices are numbers." }],
};

const POLICY = [
  "version: 1",
  "tests:",
  ...["pricing", "cart", "discount", "receipt"].map((m) => `  - command: node test/${m}.test.mjs`),
  "typecheck:",
  `  - command: node --check ${CART}`,
  "lint:",
  "  - command: node lint.mjs",
  "",
].join("\n");

const report = (criterion: string, extra: Record<string, unknown> = {}) => ({
  summary: `Met ${criterion}.`,
  criteria: [{ id: criterion, met: true }],
  ...extra,
});

/** A Developer answer for task `id`. */
function developer(
  id: string,
  criterion: string,
  files: Record<string, string>,
  extra: Partial<MockResponse> = {},
): MockResponse {
  return { match: `Task ${id}:`, output: report(criterion), writeFiles: files, ...extra };
}

const CLEAN_REVIEW: MockResponse = { output: { findings: [] } };

const CLAUDE: MockResponse[] = [
  { match: "You are the Analyst", output: SPEC },
  { match: "You are the Architect", output: DESIGN },
  {
    match: "attempt 1 of 4 of the Contracts step",
    output: { summary: "Added the contracts with stubs.", criteria: [] },
    writeFiles: { [PRICING]: PRICING_STUB, [DISCOUNT]: DISCOUNT_STUB, [RECEIPT]: RECEIPT_STUB },
  },
  {
    match: "Coverage check",
    output: {
      summary: "Read each criterion.",
      criteria: CRITERIA.map((c) => ({ id: c.id, checked: true, reason: "A test asserts it." })),
    },
  },
  // Some Developers commit their own work, as the T2 Developers did.
  developer("T1", "AC1", { [PRICING]: PRICING_DONE }, { commit: "feat(pricing): price a line" }),
  // T2 fails its task gate once, and its retry passes.
  developer("T2", "AC2", { [CART]: CART_WRONG }, { times: 1 }),
  developer("T2", "AC2", { [CART]: CART_DONE }),
  // T3 disputes the locked discount test, and runs again once it's amended.
  developer("T3", "AC3", { [DISCOUNT]: DISCOUNT_DONE }, { match: "test dispute 1 .*amended" }),
  developer(
    "T3",
    "AC3",
    { [DISCOUNT]: DISCOUNT_DONE },
    {
      output: report("AC3", {
        dispute: {
          test: DISCOUNT_TEST,
          reason: "AC3 takes 10 percent off, so 20 becomes 18, but the test wants 16.",
        },
      }),
    },
  ),
  developer("T4", "AC4", { [RECEIPT]: RECEIPT_DONE }, { commit: "feat(receipt): print the total" }),
  CLEAN_REVIEW,
];

const CODEX: MockResponse[] = [
  { match: "You are the Critic", output: CRITIC_REPLY },
  {
    match: "round 1 of",
    output: {
      summary: "Wrote the tests first.",
      tests: CRITERIA.map((c, i) => {
        const module = ["pricing", "cart", "discount", "receipt"][i]!;
        return {
          file: `test/${module}.test.mjs`,
          name: c.text,
          criterion: c.id,
          command: `node test/${module}.test.mjs`,
        };
      }),
    },
    writeFiles: { ...TESTS, [DISCOUNT_TEST]: DISCOUNT_WRONG },
  },
  {
    match: "test dispute",
    output: { verdict: "amend", reason: "The test took 20 percent off.", changesCriterion: false },
    writeFiles: { [DISCOUNT_TEST]: DISCOUNT_RIGHT },
  },
  {
    match: "Task release",
    output: {
      summary: "Recorded the priced cart.",
      pullRequest: { title: "feat(cart): price the cart", body: "Prices the cart." },
      records: [{ path: "CHANGELOG.md", kind: "changelog" }],
    },
    writeFiles: { "CHANGELOG.md": "# Changelog\n\n- Price the cart.\n" },
  },
  CLEAN_REVIEW,
];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A world whose repository has the project's commands in its policy file. */
async function gateWorld(): Promise<BuildWorld> {
  const world = await buildWorld({ steps: BUILD_PIPELINE, review: true, release: true });
  mkdirSync(join(world.root, ".aio"), { recursive: true });
  writeFileSync(join(world.root, ".aio/policy.yaml"), POLICY);
  world.script({ claude: CLAUDE, codex: CODEX });
  return world;
}

const scope = { projectId: PROJECT_ID, boxId: BOX, slug: SLUG };
const BRIEF = "Price the cart: line costs, a total, a SAVE10 discount, and a receipt.";

/** The task IDs of the Developer calls, in order. */
function developerTasks(world: BuildWorld): string[] {
  return world
    .calls()
    .filter((c) => c.prompt.startsWith("You are the Developer"))
    .map((c) => /Task (T\d+):/.exec(c.prompt)?.[1])
    .filter((id): id is string => id !== undefined);
}

describe("the reliability gate", () => {
  it(
    "runs a medium build from planning to release ready with no escalation",
    async () => {
      const world = await gateWorld();

      // Planning: the Analyst, the Architect, one Critic meeting, and the freeze.
      await world.manager.plan({ ...scope, seat: "analyst", brief: BRIEF });
      await world.manager.plan({ ...scope, seat: "architect", brief: BRIEF });
      const { meeting } = await world.manager.meet({
        ...scope,
        brief: "Attack the Architect's design.",
      });
      expect(meeting).toMatchObject({ status: "agreed", open: [] });
      expect(meeting.rounds).toHaveLength(1);
      // The owner overrides the Analyst's single-session recommendation.
      const { frozen, plan } = await world.manager.freeze({
        ...scope,
        push: false,
        flow: "pipeline",
      });
      expect(frozen).toMatchObject({ version: 1, flow: "pipeline" });
      expect(plan).toMatchObject({ size: "medium", push: false, flow: "pipeline" });
      expect(plan.tasks.map((t) => t.id)).toEqual(["T1", "T2", "T3", "T4"]);
      const planning = BuildPlanningSchema.parse(JSON.parse(world.file(SLUG, "planning.json")));
      expect(planning.calls.map((c) => [c.seat, c.status])).toEqual([
        ["analyst", "done"],
        ["architect", "done"],
        ["critic", "done"],
      ]);

      await world.manager.start({ projectId: PROJECT_ID, boxId: BOX, slug: SLUG });
      const state = await world.settle(SLUG);

      // The build reaches release ready with no escalation and no engine defect pause.
      expect(state).toMatchObject({ step: "release_ready", status: "finished" });
      expect(state.escalations).toEqual([]);
      expect(world.jsonFiles(SLUG, "escalations")).toEqual([]);
      expect(state.pausedBy ?? null).toBeNull();
      // The Project manager's inbox gets each milestone's digest and hand-off, the
      // release ready digest, and nothing that needs an answer.
      const inbox = world.events.ofType("build.inbox").map((e) => e.item);
      expect(inbox.map((i) => [i.kind, i.needsAnswer])).toEqual([
        ["digest", false],
        ["handoff", false],
        ["digest", false],
      ]);

      // The Contracts step committed the stubs before tests first locked the tests.
      expect(state.contracts).toMatchObject({ status: "done", attempts: 1 });
      const lock = JSON.parse(world.file(SLUG, "test-lock.json")) as {
        commit: string;
        redCheck: string;
        files: { path: string; sha256: string }[];
        amendments?: { taskId: string; test: string; commit: string }[];
      };
      const contractsCommit = state.contracts?.commit ?? "";
      world.git(world.root, "merge-base", "--is-ancestor", contractsCommit, lock.commit);
      expect(world.git(world.root, "show", `${contractsCommit}:${DISCOUNT}`)).toBe(
        DISCOUNT_STUB.trim(),
      );

      // Tests first locked one test per criterion, after a coverage check with no gaps.
      expect(lock.redCheck).toBe("tests-first/round-1.json");
      expect(JSON.parse(world.file(SLUG, "coverage-check.json"))).toMatchObject({ gaps: [] });
      expect(lock.files.map((f) => f.path).sort()).toEqual(
        [...Object.keys(TESTS), DISCOUNT_TEST].sort(),
      );

      // The tasks ran in dependency order: T2 once more after its failed gate,
      // and T3 once more after its dispute.
      expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
        ["T1", "done", 1],
        ["T2", "done", 2],
        ["T3", "done", 1],
        ["T4", "done", 1],
      ]);
      expect(developerTasks(world)).toEqual(["T1", "T2", "T2", "T3", "T3", "T4"]);
      expect(world.calls().filter((c) => c.prompt.startsWith("You are the Debugger"))).toEqual([]);

      // The Test engineer amended the disputed test, and the lock holds the fix.
      expect(JSON.parse(world.file(SLUG, "tasks/T3/dispute-1.json"))).toMatchObject({
        test: DISCOUNT_TEST,
        outcome: "amended",
        check: { passed: true },
      });
      expect(lock.files).toContainEqual({ path: DISCOUNT_TEST, sha256: sha256(DISCOUNT_RIGHT) });
      expect(lock.amendments).toEqual([
        expect.objectContaining({ taskId: "T3", test: DISCOUNT_TEST }),
      ]);

      // The review run found nothing, and the release trace passes every criterion.
      const { runId } = JSON.parse(world.file(SLUG, "review/run.json")) as { runId: string };
      expect(await world.runs.get(runId)).toMatchObject({
        status: "finished",
        stopReason: "clean",
      });
      const trace = JSON.parse(world.file(SLUG, "release/trace.json")) as {
        passed: boolean;
        criteria: { id: string; passed: boolean }[];
      };
      expect(trace.passed).toBe(true);
      expect(trace.criteria.map((c) => [c.id, c.passed])).toEqual(
        CRITERIA.map((c) => [c.id, true]),
      );

      // The build branch holds the finished code and the locked tests.
      const branch = `build/${SLUG}`;
      const show = (path: string) => world.git(world.root, "show", `${branch}:${path}`);
      expect(show(PRICING)).toBe(PRICING_DONE.trim());
      expect(show(CART)).toBe(CART_DONE.trim());
      expect(show(DISCOUNT)).toBe(DISCOUNT_DONE.trim());
      expect(show(RECEIPT)).toBe(RECEIPT_DONE.trim());
      expect(show(DISCOUNT_TEST)).toBe(DISCOUNT_RIGHT.trim());
    },
    BUDGET_MS,
  );
});
