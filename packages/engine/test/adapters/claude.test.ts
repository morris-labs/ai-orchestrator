import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CEILINGS, UsageSampleSchema } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ClaudeAdapter,
  claudeMcpConfig,
  ClaudeStreamParser,
  claudeAccount,
  claudeTokens,
} from "../../src/adapters/claude.js";
import { VendorFindingsOutputSchema } from "../../src/adapters/output.js";
import type { AdapterError } from "../../src/adapters/types.js";
import { type CliRequest } from "../../src/adapters/types.js";
import { fixture, lines } from "./helpers.js";
import { tempDir } from "../tmp.js";

const ceiling = DEFAULT_CEILINGS.claude;
const adapter = new ClaudeAdapter({ account: "user@example.com", bare: false });

function req<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  extra: Partial<CliRequest<T>> = {},
): CliRequest<T> {
  return {
    prompt: "p",
    cwd: "/work",
    tools: "read-only",
    timeoutMs: 1000,
    outputSchema: schema,
    ...extra,
  };
}

function replay(name: string) {
  const parser = new ClaudeStreamParser("user@example.com", ceiling);
  const raw = fixture(name);
  for (const line of lines(raw)) parser.push(line);
  return { summary: parser.summary(), raw };
}

describe("ClaudeStreamParser on sample output", () => {
  it("reads the session, model, and both rate-limit windows", () => {
    const { summary } = replay("claude-sample-review.jsonl");
    expect(summary.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(summary.model).toBe("claude-haiku-5-5");
    expect(summary.samples.map((s) => s.window).sort()).toEqual(["5h", "7d"]);
    for (const sample of summary.samples) {
      expect(UsageSampleSchema.parse(sample)).toEqual(sample);
      expect(sample.sampleSource).toBe("rate_limit_event");
      expect(sample.resetAt).toMatch(/Z$/);
    }
    expect(summary.result?.type).toBe("result");
    expect(summary.badLines).toBe(0);
  });

  it("records the API error of a not-logged-in run", () => {
    const { summary } = replay("claude-sample-not-logged-in.jsonl");
    expect(summary.apiError).toBe("authentication_failed");
    expect(summary.apiErrorText).toMatch(/Not logged in/);
  });

  it("marks a rejected rate_limit_event as a usage limit", () => {
    const parser = new ClaudeStreamParser("a", ceiling);
    const samples = parser.push(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1793166000,
          rateLimitType: "five_hour",
          utilization: 1.0,
        },
      }),
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      window: "5h",
      utilization: 1,
      resetAt: "2026-10-28T05:40:00.000Z",
    });
    expect(parser.summary().rejected).toMatchObject({
      kind: "usage_limit",
      resetAt: "2026-10-28T05:40:00.000Z",
    });
  });

  it("counts lines that aren't JSON", () => {
    const parser = new ClaudeStreamParser("a", ceiling);
    parser.push("not json");
    parser.push("42");
    expect(parser.summary().badLines).toBe(2);
  });

  it("collects tool results marked as errors", () => {
    const parser = new ClaudeStreamParser("a", ceiling);
    const user = (blocks: unknown[]) =>
      JSON.stringify({ type: "user", message: { role: "user", content: blocks } });
    parser.push(
      user([
        { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false },
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: [{ type: "text", text: "Permission denied: python3" }],
          is_error: true,
        },
      ]),
    );
    parser.push(
      user([{ type: "tool_result", tool_use_id: "t3", content: "boom", is_error: true }]),
    );
    expect(parser.summary().toolErrors).toEqual(["Permission denied: python3", "boom"]);
  });
});

describe("ClaudeAdapter.interpret", () => {
  it("returns structured findings, tokens, cost, and usage from a sample review", () => {
    const { summary, raw } = replay("claude-sample-review.jsonl");
    const result = adapter.interpret(req(VendorFindingsOutputSchema), summary, raw, "", 0, 10);
    expect(result.output.findings[0]).toMatchObject({
      file: "a.ts",
      severity: "nit",
      verdict: "pending",
    });
    expect(result.tokens.input).toBeGreaterThan(0);
    expect(result.tokens.output).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.model).toBe("claude-haiku-5-5");
    expect(result.premiumRequests).toBe(0);
    expect(result.usage).toHaveLength(2);
  });

  it("parses a sample fix run", () => {
    const { summary, raw } = replay("claude-sample-fix.jsonl");
    const result = adapter.interpret(
      req(z.object({ done: z.boolean() }), { tools: "write" }),
      summary,
      raw,
      "",
      0,
      10,
    );
    expect(result.output.done).toBe(true);
  });

  it("rejects structured output that misses the schema", () => {
    const { summary, raw } = replay("claude-sample-structured.jsonl");
    try {
      adapter.interpret(req(VendorFindingsOutputSchema), summary, raw, "", 0, 10);
      expect.unreachable();
    } catch (err) {
      expect((err as AdapterError).kind).toBe("output");
      expect((err as AdapterError).sessionId).toBe(summary.sessionId);
    }
  });

  it("reports max turns as a process error", () => {
    const { summary, raw } = replay("claude-sample-max-turns.jsonl");
    expect(() =>
      adapter.interpret(req(VendorFindingsOutputSchema), summary, raw, "", 1, 10),
    ).toThrow(/error_max_turns/);
  });

  it("doesn't take the model's own text about a 401 for a sign-in failure", () => {
    const parser = new ClaudeStreamParser("a", ceiling);
    parser.push(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: false,
        result: "The handler at src/api.ts:40 returns 401 Unauthorized when the token expires.",
        session_id: "11111111-2222-4333-8444-555555555555",
      }),
    );
    try {
      adapter.interpret(req(VendorFindingsOutputSchema), parser.summary(), "", "", 1, 10);
      expect.unreachable();
    } catch (err) {
      expect((err as AdapterError).kind).toBe("process");
      expect((err as Error).message).toMatch(/error_max_turns/);
    }
  });

  it("reports a missing sign-in as an auth error", () => {
    const { summary, raw } = replay("claude-sample-not-logged-in.jsonl");
    try {
      adapter.interpret(req(VendorFindingsOutputSchema), summary, raw, "", 1, 10);
      expect.unreachable();
    } catch (err) {
      expect((err as AdapterError).kind).toBe("auth");
    }
  });

  it("reports a usage limit from the API error text", () => {
    const parser = new ClaudeStreamParser("a", ceiling);
    parser.push(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "Claude AI usage limit reached|1793166000" }],
        },
        error: "rate_limit",
      }),
    );
    parser.push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Claude AI usage limit reached|1793166000",
      }),
    );
    try {
      adapter.interpret(req(VendorFindingsOutputSchema), parser.summary(), "", "", 1, 10);
      expect.unreachable();
    } catch (err) {
      const e = err as AdapterError;
      expect(e.kind).toBe("limit");
      expect(e.limit).toMatchObject({ kind: "usage_limit", resetAt: "2026-10-28T05:40:00.000Z" });
      expect(adapter.detectLimit(e)).toBe(e.limit);
    }
  });

  it("falls back to JSON in the result text", () => {
    const parser = new ClaudeStreamParser("a", ceiling);
    parser.push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: 'Sure: {"done":true}',
        session_id: "s",
      }),
    );
    const result = adapter.interpret(
      req(z.object({ done: z.boolean() })),
      parser.summary(),
      "",
      "",
      0,
      1,
    );
    expect(result.output.done).toBe(true);
    expect(result.sessionId).toBe("s");
  });

  it("reports a missing result line", () => {
    const parser = new ClaudeStreamParser("a", ceiling);
    expect(() => adapter.interpret(req(z.object({})), parser.summary(), "", "boom", 1, 1)).toThrow(
      /no result line/,
    );
  });
});

describe("ClaudeAdapter.buildArgs", () => {
  it("lets a read-only call write only to its scratch directory", () => {
    const args = adapter.buildArgs(req(z.object({}), { scratchDir: "/runs/r1/scratch/F-1/" }));
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash,Write");
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("Edit(//runs/r1/scratch/F-1/**)");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(
      "Edit,NotebookEdit,Bash(*--output*),Bash(*--ext-diff*),Bash(*--textconv*)",
    );
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  it("builds a read-only review", () => {
    const args = adapter.buildArgs(
      req(VendorFindingsOutputSchema, {
        model: "opus",
        effort: "medium",
        maxTurns: 5,
        maxBudgetUsd: 2,
        systemPrompt: "S",
      }),
    );
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(args).not.toContain("--bare");
    expect(args).toEqual(
      expect.arrayContaining([
        "--model",
        "opus",
        "--effort",
        "medium",
        "--max-turns",
        "5",
        "--max-budget-usd",
        "2",
      ]),
    );
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("S");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(
      "Edit,Write,NotebookEdit,Bash(*--output*),Bash(*--ext-diff*),Bash(*--textconv*)",
    );
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toHaveProperty(
      "properties.findings",
    );
    expect(args).not.toContain("--resume");
  });

  it("builds a write call with bypass permissions and resume", () => {
    const args = adapter.buildArgs(req(z.object({}), { tools: "write", sessionId: "abc" }));
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(args[args.indexOf("--resume") + 1]).toBe("abc");
    expect(args).not.toContain("--tools");
  });

  it("attaches the team chat bus through a config file, with its tools allowed", () => {
    const team = {
      server: "aio_team",
      url: "http://127.0.0.1:41000/mcp",
      token: "secret-token-value",
      tools: ["send_message"],
    };
    const readOnly = adapter.buildArgs(
      req(z.object({}), { team }),
      {},
      { mcpConfig: "/t/mcp.json" },
    );
    expect(readOnly[readOnly.indexOf("--mcp-config") + 1]).toBe("/t/mcp.json");
    expect(readOnly).toContain("--strict-mcp-config");
    expect(readOnly[readOnly.indexOf("--allowedTools") + 1]).toMatch(
      /^Read,.*,mcp__aio_team__send_message$/,
    );
    const write = adapter.buildArgs(
      req(z.object({}), { team, tools: "write", sessionId: "abc" }),
      {},
      { mcpConfig: "/t/mcp.json" },
    );
    expect(write[write.indexOf("--allowedTools") + 1]).toBe("mcp__aio_team__send_message");
    expect(write).toContain("--strict-mcp-config");
    expect(write[write.indexOf("--resume") + 1]).toBe("abc");
    expect([...readOnly, ...write].join(" ")).not.toContain("secret-token-value");
  });

  it("writes the bus's URL and the agent's token in the MCP config", () => {
    expect(
      claudeMcpConfig({
        server: "aio_team",
        url: "http://127.0.0.1:41000/mcp",
        token: "tok",
        tools: ["send_message"],
      }),
    ).toEqual({
      mcpServers: {
        aio_team: {
          type: "http",
          url: "http://127.0.0.1:41000/mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });
  });

  it("passes no MCP flags without the bus", () => {
    const args = adapter.buildArgs(req(z.object({}), { tools: "write" }));
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--allowedTools");
  });

  it("adds each extra directory with --add-dir", () => {
    const args = adapter.buildArgs(req(z.object({}), { addDirs: ["/base", "/scratch"] }));
    expect(args.join(" ")).toContain("--add-dir /base --add-dir /scratch");
  });

  it("adds --bare when asked", () => {
    expect(new ClaudeAdapter({ bare: true }).buildArgs(req(z.object({})))).toContain("--bare");
  });

  it("adds --bare when the broker gives an API key", () => {
    const brokered = new ClaudeAdapter({ account: "user@example.com" });
    expect(brokered.buildArgs(req(z.object({})), { ANTHROPIC_API_KEY: "SYNTHETIC_key" })).toContain(
      "--bare",
    );
  });

  it("turns session persistence off only when asked", () => {
    expect(adapter.buildArgs(req(z.object({})))).not.toContain("--no-session-persistence");
    expect(new ClaudeAdapter({ persistSessions: false }).buildArgs(req(z.object({})))).toContain(
      "--no-session-persistence",
    );
  });
});

describe("claudeTokens", () => {
  it("falls back to the usage block without modelUsage", () => {
    expect(
      claudeTokens(
        { usage: { input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } },
        "m",
      ),
    ).toEqual({
      tokens: { input: 5, output: 4, fresh: 2, cacheWrite: 0, cacheRead: 3 },
      model: "m",
    });
  });
});

describe("claudeAccount", () => {
  it("reads the OAuth email and tolerates a missing file", () => {
    const dir = tempDir("aio-acct-");
    const file = join(dir, "claude.json");
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "user@example.com" } }));
    expect(claudeAccount(file)).toBe("user@example.com");
    expect(claudeAccount(join(dir, "missing.json"))).toBeNull();
  });

  it("keeps the last email while another claude rewrites the file", () => {
    const dir = tempDir("aio-acct-");
    const file = join(dir, "claude.json");
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "user@example.com" } }));
    expect(claudeAccount(file)).toBe("user@example.com");
    writeFileSync(file, '{"oauthAccount": {"emailAdd');
    expect(claudeAccount(file)).toBe("user@example.com");
    writeFileSync(file, "");
    expect(claudeAccount(file)).toBe("user@example.com");
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "other@example.com" } }));
    expect(claudeAccount(file)).toBe("other@example.com");
  });
});
