// Messages the server sends a box's session on its own, such as the request
// to hold edits during a review run: they wait while the session shows a
// dialog and go out once it can take them.
import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryRequest, DeliveryResult } from "../../src/boxes/delivery.js";
import { SessionMessages } from "../../src/boxes/session-messages.js";

const HOLD = "A review run has started on this branch. Hold all edits.";
const RELEASE = "The review run on this branch has ended.";

const open: SessionMessages[] = [];
afterEach(() => {
  for (const m of open.splice(0)) m.close();
});

/** A box whose session answers each attempt with the next result in `answers`, then takes every message. */
function world(answers: DeliveryResult[], options: { giveUpMs?: number } = {}) {
  const typed: string[] = [];
  const attempts: string[] = [];
  const logs: string[] = [];
  const messages = new SessionMessages({
    deliver: async (_boxId: string, request: DeliveryRequest) => {
      attempts.push(request.text);
      const answer = answers.shift() ?? { delivered: true, confirmed: true };
      if (answer.delivered) typed.push(request.text);
      return answer;
    },
    log: (m) => logs.push(m),
    retryMs: 10,
    ...options,
  });
  open.push(messages);
  return { messages, typed, attempts, logs };
}

const dialog: DeliveryResult = { delivered: false, reason: "The session shows a dialog." };

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
}

describe("session messages", () => {
  it("sends a message again after a dialog, until the session takes it", async () => {
    const w = world([dialog, dialog]);
    w.messages.send("box-a", HOLD);
    await until(() => w.typed.length === 1);
    expect(w.attempts).toEqual([HOLD, HOLD, HOLD]);
    expect(w.logs).toHaveLength(1);
  });

  it("keeps the order of a box's messages", async () => {
    const w = world([dialog]);
    w.messages.send("box-a", "first");
    w.messages.send("box-a", "second");
    await until(() => w.typed.length === 2);
    expect(w.typed).toEqual(["first", "second"]);
  });

  it("sends neither message when a release follows a hold that never went out", async () => {
    const w = world([dialog, dialog, dialog]);
    w.messages.send("box-a", HOLD);
    await until(() => w.attempts.length === 1);
    w.messages.send("box-a", RELEASE, { withdraws: HOLD });
    await w.messages.idle();
    await new Promise((r) => setTimeout(r, 40));
    expect(w.typed).toEqual([]);
  });

  it("drops a message for a stopped box or a session that never takes one, and says why", async () => {
    const w = world([
      { delivered: false, stopped: true, reason: "box-a is not running." },
      { delivered: false, unsupported: true, reason: "The session runs codex." },
    ]);
    w.messages.send("box-a", HOLD);
    w.messages.send("box-b", HOLD);
    await w.messages.idle();
    await new Promise((r) => setTimeout(r, 40));
    expect(w.attempts).toEqual([HOLD, HOLD]);
    expect(w.logs.join("\n")).toContain("not running");
    expect(w.logs.join("\n")).toContain("codex");
  });

  it("gives up on a message that waits too long", async () => {
    const w = world(Array.from({ length: 100 }, () => dialog), { giveUpMs: 30 });
    w.messages.send("box-a", HOLD);
    await until(() => w.logs.some((l) => l.includes("Gave up")));
    const count = w.attempts.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(w.attempts.length).toBe(count);
  });
});
