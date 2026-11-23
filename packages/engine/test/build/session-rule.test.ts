// The rule that picks between resuming an agent's session for a message and
// starting a fresh agent: size against the threshold, the vendor's cache
// window, and the seat's placement.
import { BuildSessionSettingsSchema, type SeatPlacement, type SessionRecord } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { freshReason } from "../../src/build/sessions/index.js";

const T0 = Date.parse("2026-10-28T09:00:00.000Z");
const MIN = 60_000;

const placement: SeatPlacement = {
  seat: "developer",
  vendor: "claude",
  tier: "large",
  effort: "high",
  sources: { vendor: "role", tier: "role", effort: "role" },
  fresh: false,
};

function session(inputTokens: number, vendor: SessionRecord["vendor"] = "claude"): SessionRecord {
  return {
    id: "S1",
    seat: "developer",
    taskId: "T1",
    step: "tasks",
    vendor,
    model: "model",
    sessionId: "session-1",
    placement: { ...placement, vendor },
    reason: "step",
    replaces: null,
    replacedBy: null,
    startedAt: new Date(T0).toISOString(),
    turns: [
      {
        key: "T1-attempt-1",
        messageId: null,
        at: new Date(T0).toISOString(),
        head: "a".repeat(40),
        inputTokens,
      },
    ],
  };
}

const settings = BuildSessionSettingsSchema.parse({});
const LARGE = 150_000;
const SMALL = 20_000;

describe("whether a message resumes a session", () => {
  it("resumes a large session while the vendor's cache lasts", () => {
    expect(freshReason(session(LARGE), placement, T0 + 59 * MIN, settings)).toBeNull();
  });

  it("resumes a small session after the cache expired", () => {
    expect(freshReason(session(SMALL), placement, T0 + 3 * 60 * MIN, settings)).toBeNull();
  });

  it("starts a fresh agent for a large session after the cache expired", () => {
    expect(freshReason(session(LARGE), placement, T0 + 61 * MIN, settings)).toBe("size");
  });

  it("uses each vendor's own cache window", () => {
    const codex = { ...placement, vendor: "codex" as const };
    expect(freshReason(session(LARGE, "codex"), codex, T0 + 29 * MIN, settings)).toBeNull();
    expect(freshReason(session(LARGE, "codex"), codex, T0 + 31 * MIN, settings)).toBe("size");
  });

  it("reads the threshold and the windows from the settings", () => {
    const tight = BuildSessionSettingsSchema.parse({
      freshAboveTokens: 10_000,
      cacheWindowMinutes: { claude: 5 },
    });
    expect(freshReason(session(SMALL), placement, T0 + 6 * MIN, tight)).toBe("size");
    expect(freshReason(session(SMALL), placement, T0 + 4 * MIN, tight)).toBeNull();
  });

  it("starts a fresh agent when the seat's placement changed", () => {
    const changed = { ...placement, effort: "medium" as const };
    expect(freshReason(session(SMALL), changed, T0 + MIN, settings)).toBe("placement");
    const moved = { ...placement, vendor: "codex" as const };
    expect(freshReason(session(SMALL), moved, T0 + MIN, settings)).toBe("placement");
  });

  it("starts a fresh agent when the placement asks for one or the vendor kept no session", () => {
    expect(freshReason(session(SMALL), { ...placement, fresh: true }, T0, settings)).toBe(
      "placement",
    );
    expect(freshReason({ ...session(SMALL), sessionId: null }, placement, T0, settings)).toBe(
      "no_session",
    );
  });
});
