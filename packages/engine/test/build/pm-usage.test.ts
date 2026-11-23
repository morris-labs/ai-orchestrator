// The Project manager's usage from its transcript (#93). The Project
// manager makes no engine calls, so the engine reads its token counts from
// the Claude Code transcripts of its sessions. Every fixture transcript
// lives in a temporary folder, never in the real transcript store.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionTranscripts, transcriptUsage } from "../../src/build/pm-usage.js";
import { tempDir } from "../tmp.js";
import { CART_DONE, PROJECT_ID, REPORT, buildWorld, cartPlan } from "./harness.js";

const SESSION = "8f1c2d3e-0000-4000-8000-000000000001";
const RESUMED = "8f1c2d3e-0000-4000-8000-000000000002";

interface Turn {
  id: string;
  time: string;
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
}

/** One assistant line, as Claude Code writes it for each content block of a response. */
function assistant(turn: Turn, sessionId = SESSION): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    uuid: `${turn.id}-${Math.random()}`,
    timestamp: turn.time,
    requestId: `req_${turn.id}`,
    message: {
      id: `msg_${turn.id}`,
      role: "assistant",
      model: "claude-example",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input_tokens: turn.input ?? 0,
        cache_creation_input_tokens: turn.cacheWrite ?? 0,
        cache_read_input_tokens: turn.cacheRead ?? 0,
        output_tokens: turn.output ?? 0,
      },
    },
  });
}

function user(text: string, time: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    sessionId: SESSION,
    timestamp: time,
    message: { role: "user", content: text },
    ...extra,
  });
}

function write(file: string, lines: string[]): string {
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

const T = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("transcript usage", () => {
  it("counts each model response once, though Claude Code writes a line for each content block", async () => {
    const dir = tempDir("aio-pm-usage-");
    const turn = { id: "a", time: T(1), input: 10, cacheWrite: 100, cacheRead: 1000, output: 5 };
    const file = write(join(dir, `${SESSION}.jsonl`), [
      user("Plan the build.", T(0)),
      assistant(turn),
      assistant(turn),
      assistant({ id: "b", time: T(2), input: 20, output: 7 }),
      "not json",
      JSON.stringify({ type: "summary", summary: "A title" }),
    ]);

    expect(await transcriptUsage([file], { since: T(0) })).toEqual({
      turns: 2,
      tokensIn: 1130,
      tokensOut: 12,
    });
  });

  it("counts only turns after the build's planning started", async () => {
    const dir = tempDir("aio-pm-usage-");
    const file = write(join(dir, `${SESSION}.jsonl`), [
      assistant({ id: "before", time: T(1), input: 500, output: 50 }),
      user("aio-build plan cart-total analyst", T(5)),
      assistant({ id: "after", time: T(6), input: 40, output: 4 }),
    ]);

    expect(await transcriptUsage([file], { since: T(5) })).toEqual({
      turns: 1,
      tokensIn: 40,
      tokensOut: 4,
    });
    expect(await transcriptUsage([file], { since: T(0), until: T(5) })).toEqual({
      turns: 1,
      tokensIn: 500,
      tokensOut: 50,
    });
  });

  it("doesn't double count a compaction or a resumed session that copies earlier turns", async () => {
    const dir = tempDir("aio-pm-usage-");
    const first = { id: "a", time: T(1), input: 100, output: 10 };
    const second = { id: "b", time: T(2), input: 200, output: 20 };
    const original = write(join(dir, `${SESSION}.jsonl`), [
      assistant(first),
      assistant(second),
      user("This session continues from an earlier one that ran out of context.", T(3), {
        isCompactSummary: true,
      }),
      assistant({ id: "c", time: T(4), input: 300, output: 30 }),
    ]);
    // A resume or a fork writes a new transcript that starts with a copy of
    // the earlier turns, under the new session's ID.
    const resumed = write(join(dir, `${RESUMED}.jsonl`), [
      assistant(first, RESUMED),
      assistant(second, RESUMED),
      assistant({ id: "d", time: T(9), input: 400, output: 40 }, RESUMED),
    ]);

    expect(await transcriptUsage([original, resumed, original], { since: T(0) })).toEqual({
      turns: 4,
      tokensIn: 1000,
      tokensOut: 100,
    });
  });

  it("counts nothing for a transcript that's missing", async () => {
    const dir = tempDir("aio-pm-usage-");
    expect(await transcriptUsage([join(dir, "gone.jsonl")], { since: T(0) })).toEqual({
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
  });
});

describe("session transcripts", () => {
  it("finds a session's transcript and its subagents' in any working directory folder", async () => {
    const store = tempDir("aio-pm-store-");
    const project = join(store, "-work-shop");
    mkdirSync(join(project, SESSION, "subagents"), { recursive: true });
    mkdirSync(join(store, "-work-other"));
    write(join(project, `${SESSION}.jsonl`), []);
    write(join(project, SESSION, "subagents", "agent-1.jsonl"), []);
    write(join(project, `${RESUMED}.jsonl`), []);
    write(join(store, "-work-other", "unrelated.jsonl"), []);

    expect(
      (await sessionTranscripts({ id: SESSION, transcripts: store })).map((f) =>
        f.slice(store.length),
      ),
    ).toEqual([
      `/-work-shop/${SESSION}.jsonl`,
      `/-work-shop/${SESSION}/subagents/agent-1.jsonl`,
    ]);
    expect(await sessionTranscripts({ id: SESSION, transcripts: join(store, "missing") })).toEqual(
      [],
    );
  });
});

/** A test command that can't run (exit 127) until `marker` exists. */
function gatedPlan(marker: string) {
  const plan = cartPlan();
  plan.commands = {
    ...plan.commands,
    test: [{ command: `test -f ${marker} || exit 127; node test/cart.test.mjs` }],
  };
  return plan;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("the Project manager's usage in a build", () => {
  it("records only the sessions of the build's own box", async () => {
    const world = await buildWorld();
    const marker = join(tempDir("aio-marker-"), "ready");
    world.script({ claude: [{ match: "Task T1", output: REPORT }] });
    await world.manager.start({
      projectId: PROJECT_ID,
      boxId: "box-pm",
      slug: "cart-total",
      plan: gatedPlan(marker),
    });
    const store = tempDir("aio-pm-store-");

    await world.manager.noteSession("cart-total", "box-pm", { id: SESSION, transcripts: store });
    await world.manager.noteSession("cart-total", "box-pm", { id: SESSION, transcripts: store });
    await world.manager.noteSession("cart-total", "box-other", { id: RESUMED, transcripts: store });
    await world.manager.noteSession("no-such-build", "box-pm", { id: RESUMED, transcripts: store });

    const file = join(world.dir("cart-total"), "pm-sessions.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { sessions: { id: string }[] };
    expect(saved.sessions.map((s) => s.id)).toEqual([SESSION]);
    expect(existsSync(join(world.dir("no-such-build")))).toBe(false);
    await world.settle("cart-total");
  });

  it("puts the Project manager's turns since planning started in each digest, marked tokens only", async () => {
    const world = await buildWorld();
    const marker = join(tempDir("aio-marker-"), "ready");
    world.script({
      claude: [
        {
          match: "Task T1",
          output: REPORT,
          writeFiles: { "src/cart.mjs": CART_DONE },
          tokens: { input: 1000, output: 100 },
        },
      ],
    });
    await world.manager.start({
      projectId: PROJECT_ID,
      boxId: "box-pm",
      slug: "cart-total",
      plan: gatedPlan(marker),
    });
    await world.settle("cart-total");

    // The Project manager's transcripts: one turn from before the build,
    // two after it, and a resumed session that copies them and adds one.
    const store = tempDir("aio-pm-store-");
    const project = join(store, "-work-shop");
    mkdirSync(project);
    const old = { id: "old", time: ago(3_600_000), input: 9000, output: 900 };
    const first = { id: "a", time: ago(0), input: 100, output: 10 };
    const second = { id: "b", time: ago(0), input: 200, output: 20 };
    write(join(project, `${SESSION}.jsonl`), [assistant(old), assistant(first), assistant(second)]);
    write(join(project, `${RESUMED}.jsonl`), [
      assistant(old, RESUMED),
      assistant(first, RESUMED),
      assistant(second, RESUMED),
      assistant({ id: "c", time: ago(0), input: 300, output: 30 }, RESUMED),
    ]);
    await world.manager.noteSession("cart-total", "box-pm", { id: SESSION, transcripts: store });
    await world.manager.noteSession("cart-total", "box-pm", { id: RESUMED, transcripts: store });

    writeFileSync(marker, "");
    await world.manager.resolve("cart-total", { escalation: "E1", action: "retry" });
    await world.waitFor("cart-total", (s) => s.step === "review");
    await world.settle("cart-total");

    const digest = world.file("cart-total", "digests/milestone-all.md");
    expect(digest).toContain("| developer | 1 | 1000 | 100 |");
    expect(digest).toContain("| Total | 1 | 1000 | 100 |");
    expect(digest).toContain("| project-manager (tokens only) | 3 turns | 600 | 60 | n/a |");
    const usage = world.events.ofType("build.seat.usage");
    expect(usage.at(-1)).toMatchObject({
      seat: "project-manager",
      turns: 3,
      tokensIn: 600,
      tokensOut: 60,
    });
  });
});
