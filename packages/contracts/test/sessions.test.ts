// The session registry of a build and the settings of its size rule.
import { describe, expect, it } from "vitest";
import {
  BuildSessionSettingsSchema,
  PolicyFileSchema,
  SessionRegistrySchema,
} from "../src/index.js";
import { T0 } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

const placement = {
  seat: "developer",
  vendor: "claude",
  tier: "large",
  effort: "high",
  sources: { vendor: "role", tier: "role", effort: "role" },
  fresh: false,
};

const session = {
  id: "S1",
  seat: "developer",
  taskId: "T1",
  step: "tasks",
  vendor: "claude",
  model: "claude-opus-4",
  sessionId: "5f0c3a52-8d7e-4c1b-9a51-3a0b6f2e9d11",
  placement,
  reason: "step",
  replaces: null,
  replacedBy: null,
  startedAt: T0,
  turns: [
    { key: "T1-attempt-1", messageId: null, at: T0, head: "a".repeat(40), inputTokens: 1200 },
  ],
};

describe("session settings", () => {
  it("defaults to 100,000 tokens and the design's cache windows", () => {
    expect(roundTrip(BuildSessionSettingsSchema, {})).toEqual({
      freshAboveTokens: 100_000,
      cacheWindowMinutes: { claude: 60, codex: 30, copilot: 5 },
    });
  });

  it("keeps the other vendors' defaults when the policy sets one window", () => {
    const policy = PolicyFileSchema.parse({
      version: 1,
      sessions: { freshAboveTokens: 50_000, cacheWindowMinutes: { codex: 45 } },
    });
    expect(policy.sessions).toEqual({
      freshAboveTokens: 50_000,
      cacheWindowMinutes: { claude: 60, codex: 45, copilot: 5 },
    });
  });

  it("rejects an unknown vendor and a negative window", () => {
    expect(() =>
      BuildSessionSettingsSchema.parse({ cacheWindowMinutes: { gemini: 10 } }),
    ).toThrow(/gemini/);
    expect(() => BuildSessionSettingsSchema.parse({ cacheWindowMinutes: { claude: -1 } })).toThrow(
      /claude/,
    );
  });
});

describe("the session registry", () => {
  it("starts empty", () => {
    expect(roundTrip(SessionRegistrySchema, {})).toEqual({
      version: 1,
      sessions: [],
      queue: [],
      deliveries: [],
    });
  });

  it("keeps a replaced session, its replacement, and the message queue through a save", () => {
    const saved = {
      version: 1,
      sessions: [
        { ...session, replacedBy: "S2" },
        {
          ...session,
          id: "S2",
          reason: "size",
          replaces: "S1",
          turns: [{ ...session.turns[0], key: "message-M2-developer-T1", messageId: "M2" }],
        },
      ],
      queue: [{ messageId: "M3", seat: "developer", taskId: "T1" }],
      deliveries: [{ messageId: "M2", session: "S2", status: "delivered", at: T0 }],
    };
    expect(roundTrip(SessionRegistrySchema, saved)).toEqual(saved);
  });

  it("rejects a session with no turn or an unknown reason", () => {
    expect(() =>
      SessionRegistrySchema.parse({ sessions: [{ ...session, turns: [] }] }),
    ).toThrow(/turns/);
    expect(() =>
      SessionRegistrySchema.parse({ sessions: [{ ...session, reason: "bored" }] }),
    ).toThrow(/reason/);
  });
});
