import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_CEILINGS } from "@agentbox/contracts";
import { detectLimitInText, parseResetTime } from "../../src/adapters/base.js";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { CopilotAdapter } from "../../src/adapters/copilot.js";
import type { ProcessResult } from "../../src/adapters/process.js";
import { tempDir } from "../tmp.js";

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

describe("limit detection reads only the CLI's error channels", () => {
  it("ignores limit words in the model's output", async () => {
    const { AdapterError } = await import("../../src/adapters/types.js");
    const { limitFromError } = await import("../../src/adapters/base.js");
    const { ClaudeAdapter, ClaudeStreamParser } = await import("../../src/adapters/claude.js");
    const { CodexAdapter } = await import("../../src/adapters/codex.js");
    const { CopilotAdapter } = await import("../../src/adapters/copilot.js");
    const { z } = await import("zod");
    const modelText = "The client retries on HTTP 429 Too Many Requests and a usage limit.";
    const output = new AdapterError("codex", "output", "Unusable answer", { raw: modelText });
    expect(limitFromError(output)).toBeNull();
    for (const adapter of [new ClaudeAdapter(), new CodexAdapter(), new CopilotAdapter()]) {
      expect(adapter.detectLimit(output)).toBeNull();
    }
    // A failed Claude turn whose final text mentions a limit is not a limit.
    const claude = new ClaudeAdapter({ bare: false });
    const parser = new ClaudeStreamParser("a", DEFAULT_CEILINGS.claude);
    parser.push(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: false,
        result: modelText,
        session_id: "s",
      }),
    );
    const req = {
      prompt: "p",
      cwd: "/",
      tools: "read-only" as const,
      timeoutMs: 1,
      outputSchema: z.object({}),
    };
    try {
      claude.interpret(req, parser.summary(), modelText, "", 1, 1);
      expect.unreachable();
    } catch (error) {
      expect((error as InstanceType<typeof AdapterError>).kind).toBe("process");
    }
    // The real limit signal on stderr still counts.
    const limited = new AdapterError("claude", "limit", "usage limit", {
      limit: { kind: "usage_limit", resetAt: null, message: "usage limit" },
    });
    expect(limitFromError(limited)?.kind).toBe("usage_limit");
  });
});

describe("exitFailure", () => {
  class Probe extends CodexAdapter {
    fail(result: ProcessResult, text: string) {
      return this.exitFailure(result, null, text);
    }
  }
  const result = (stdout: string, stderr: string): ProcessResult => ({
    stdout,
    stderr,
    exitCode: 1,
    signal: null,
    timedOut: false,
    cancelled: false,
    durationMs: 1,
    spawnError: null,
  });

  it("classifies by stderr and error events, never by stdout", () => {
    const p = new Probe();
    expect(p.fail(result('{"text":"handles 429 too many requests"}', ""), "").kind).toBe("process");
    expect(p.fail(result("", "error: 429 Too Many Requests"), "").kind).toBe("limit");
    expect(p.fail(result("", ""), "You've hit your usage limit.").kind).toBe("limit");
  });
});

describe("vendor environment", () => {
  it("keeps every vendor CLI from writing Python bytecode", async () => {
    const dir = tempDir("vendor-env-");
    const seen = join(dir, "seen.txt");
    const cli = join(dir, "cli");
    writeFileSync(
      cli,
      `#!/bin/sh\nprintf '%s\\n' "\${PYTHONDONTWRITEBYTECODE:-unset}" >> '${seen}'\nexit 1\n`,
      { mode: 0o755 },
    );
    const req = {
      prompt: "p",
      cwd: dir,
      tools: "read-only" as const,
      timeoutMs: 10_000,
      outputSchema: z.object({}),
    };
    for (const adapter of [
      new ClaudeAdapter({ command: cli }),
      new CodexAdapter({ command: cli }),
      new CopilotAdapter({ command: cli }),
    ]) {
      await adapter.review(req).catch(() => undefined);
    }
    await new CodexAdapter({ command: cli, env: { PYTHONDONTWRITEBYTECODE: undefined } })
      .review(req)
      .catch(() => undefined);
    expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual(["1", "1", "1", "unset"]);
  });
});
