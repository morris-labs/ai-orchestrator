import { describe, expect, it } from "vitest";
import { detectLimitInText, parseResetTime } from "../../src/adapters/base.js";

const now = new Date("2026-10-28T09:00:00Z");

describe("detectLimitInText", () => {
  it("finds Claude's usage limit with an epoch reset", () => {
    expect(detectLimitInText("Claude AI usage limit reached|1793170800", now)).toEqual({
      kind: "usage_limit",
      resetAt: "2026-10-28T07:00:00.000Z",
      message: "Claude AI usage limit reached|1793170800",
    });
  });

  it("finds the newer Claude limit message", () => {
    expect(detectLimitInText("You've hit your limit · resets 3pm (UTC)", now)?.kind).toBe(
      "usage_limit",
    );
  });

  it("finds Codex's usage limit with a clock reset", () => {
    const limit = detectLimitInText("You’ve hit your usage limit. Try again at 3:15 PM.", now);
    expect(limit?.kind).toBe("usage_limit");
    const reset = new Date(limit!.resetAt!);
    expect(reset.getHours()).toBe(15);
    expect(reset.getMinutes()).toBe(15);
    expect(reset.getTime()).toBeGreaterThan(now.getTime());
  });

  it("classifies a 429 as a rate limit", () => {
    expect(
      detectLimitInText("exceeded retry limit, last status: 429 Too Many Requests", now)?.kind,
    ).toBe("rate_limit");
  });

  it("finds quota text", () => {
    expect(
      detectLimitInText("Quota exceeded. Check your plan and billing details.", now)?.kind,
    ).toBe("usage_limit");
  });

  it("returns null for unrelated errors", () => {
    expect(detectLimitInText("stream disconnected before completion", now)).toBeNull();
  });
});

describe("parseResetTime", () => {
  it("reads a relative duration", () => {
    expect(parseResetTime("Rate limit exceeded. Try again in 2 hours 5 minutes.", now)).toBe(
      "2026-10-28T11:05:00.000Z",
    );
    expect(parseResetTime("resets in 30m", now)).toBe("2026-10-28T09:30:00.000Z");
  });

  it("reads an ISO time", () => {
    expect(parseResetTime("blocked until 2026-10-29T00:00:00Z", now)).toBe(
      "2026-10-29T00:00:00.000Z",
    );
  });

  it("rolls a past clock time to the next day", () => {
    const evening = new Date(now);
    evening.setHours(22, 0, 0, 0);
    const reset = new Date(parseResetTime("Try again at 1:00 AM", evening)!);
    expect(reset.getHours()).toBe(1);
    expect(reset.getTime() - evening.getTime()).toBe(3 * 3_600_000);
  });

  it("reads a 24-hour clock time", () => {
    const morning = new Date(now);
    morning.setHours(8, 0, 0, 0);
    expect(new Date(parseResetTime("try again at 13:30", morning)!).getHours()).toBe(13);
  });

  it("returns null without a time", () => {
    expect(parseResetTime("Try again later.", now)).toBeNull();
  });
});
