import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CEILINGS, UsageSampleSchema } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CodexAdapter,
  CodexStreamParser,
  codexRateLimitSamples,
  findRolloutFile,
} from "../../src/adapters/codex.js";
import { parseStructuredText, VendorFindingsOutputSchema } from "../../src/adapters/output.js";
import type { CliRequest } from "../../src/adapters/types.js";
import { fixture, lines } from "./helpers.js";
import { tempDir } from "../tmp.js";

function parse(name: string) {
  const parser = new CodexStreamParser();
  for (const line of lines(fixture(name))) parser.push(line);
  return parser.summary();
}

const base: CliRequest<unknown> = {
  prompt: "p",
  cwd: "/w",
  tools: "read-only",
  timeoutMs: 1,
  outputSchema: z.object({}),
};

describe("CodexStreamParser", () => {
  it("reads the thread, tokens, and last agent message", () => {
    const s = parse("codex-review.jsonl");
    expect(s.threadId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    expect(s.tokens).toEqual({
      input: 24763,
      output: 122,
      fresh: 315,
      cacheWrite: 0,
      cacheRead: 24448,
    });
    expect(s.errors).toEqual([]);
    expect(s.turnsCompleted).toBe(1);
    const output = parseStructuredText("codex", VendorFindingsOutputSchema, s.lastMessage!, "");
    expect(output.findings[0]).toMatchObject({
      severity: "P1",
      lines: [120, 134],
      verdict: "pending",
    });
  });

  it("leaves out the token breakdown when a turn omits cached_input_tokens", () => {
    const parser = new CodexStreamParser();
    parser.push(
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 10 } }),
    );
    expect(parser.summary().tokens).toEqual({ input: 1000, output: 10 });
  });

  it("collects turn.failed messages", () => {
    const s = parse("codex-usage-limit.jsonl");
    expect(s.errors).toEqual(["You’ve hit your usage limit. Try again at 3:15 PM."]);
    expect(s.lastMessage).toBeNull();
  });

  it("collects failed and declined commands as tool errors", () => {
    const parser = new CodexStreamParser();
    const item = (status: string, output: string) =>
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "i",
          type: "command_execution",
          command: "bash -lc 'python3 -c 1'",
          aggregated_output: output,
          exit_code: 1,
          status,
        },
      });
    parser.push(item("failed", "bwrap: No permissions to create a new namespace"));
    parser.push(item("completed", "ok"));
    parser.push(item("declined", ""));
    expect(parser.summary().toolErrors).toEqual([
      "bash -lc 'python3 -c 1': bwrap: No permissions to create a new namespace",
      "bash -lc 'python3 -c 1': declined",
    ]);
  });
});

describe("CodexStreamParser MCP tool calls", () => {
  it("collects failed MCP tool calls, such as a refused bus call, as tool errors", () => {
    const parser = new CodexStreamParser();
    const item = (status: string, extra: Record<string, unknown>) =>
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "i",
          type: "mcp_tool_call",
          server: "aio_team",
          tool: "send_message",
          status,
          ...extra,
        },
      });
    parser.push(
      item("failed", {
        error: { message: "MCP tool call requires approval, but approval policy is never" },
      }),
    );
    parser.push(item("completed", { result: { content: [] } }));
    expect(parser.summary().toolErrors).toEqual([
      "aio_team.send_message: MCP tool call requires approval, but approval policy is never",
    ]);
  });
});

describe("codexRateLimitSamples", () => {
  it("reads the newest token_count rate limits", () => {
    const samples = codexRateLimitSamples(
      fixture("codex-rollout.jsonl"),
      "user@example.com",
      DEFAULT_CEILINGS.codex,
    );
    expect(samples).toEqual([
      expect.objectContaining({
        window: "5h",
        utilization: 0.145,
        resetAt: "2026-10-28T07:00:00.000Z",
        sampleSource: "codex_session",
      }),
      expect.objectContaining({ window: "7d", utilization: 0.41 }),
    ]);
    for (const s of samples) UsageSampleSchema.parse(s);
  });

  it("returns nothing without rate limits", () => {
    expect(
      codexRateLimitSamples(
        '{"payload":{"type":"token_count","rate_limits":null}}',
        "a",
        DEFAULT_CEILINGS.codex,
      ),
    ).toEqual([]);
  });
});

describe("findRolloutFile", () => {
  it("finds the thread's rollout in the newest day directories", () => {
    const sessions = tempDir("aio-codex-sessions-");
    const day = join(sessions, "2026", "10", "28");
    mkdirSync(day, { recursive: true });
    mkdirSync(join(sessions, "2026", "10", "27"), { recursive: true });
    writeFileSync(join(day, "rollout-2026-10-28T09-00-00-abc.jsonl"), "");
    expect(findRolloutFile(sessions, "abc")).toBe(
      join(day, "rollout-2026-10-28T09-00-00-abc.jsonl"),
    );
    expect(findRolloutFile(sessions, "zzz")).toBeNull();
    expect(findRolloutFile(join(sessions, "missing"), "abc")).toBeNull();
  });
});

describe("CodexAdapter.buildArgs", () => {
  const adapter = new CodexAdapter();
  const ownSandbox = new CodexAdapter({ sandbox: "codex" });

  it("builds an exec with the prompt on stdin and the container as the sandbox", () => {
    const args = adapter.buildArgs({ ...base, model: "gpt-5.3-codex", effort: "high" }, "/s.json");
    expect(args).toEqual([
      "exec",
      "--sandbox",
      "danger-full-access",
      "--json",
      "--skip-git-repo-check",
      "--output-schema",
      "/s.json",
      "--model",
      "gpt-5.3-codex",
      "-c",
      'model_reasoning_effort="high"',
      "-",
    ]);
    expect(adapter.buildArgs({ ...base, tools: "write" }, "/s")).toContain("danger-full-access");
    expect(adapter.buildArgs({ ...base, tools: "write" }, "/s")).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("attaches the team chat bus on a first call and on a resume, with approval and a token variable", () => {
    const team = {
      server: "aio_team",
      url: "http://127.0.0.1:41000/mcp",
      token: "secret-token-value",
      tools: ["send_message"],
    };
    const overrides = [
      "-c",
      'mcp_servers.aio_team.url="http://127.0.0.1:41000/mcp"',
      "-c",
      'mcp_servers.aio_team.bearer_token_env_var="AIO_TEAM_TOKEN"',
      "-c",
      'mcp_servers.aio_team.default_tools_approval_mode="approve"',
    ];
    const first = adapter.buildArgs({ ...base, team }, "/s.json");
    const resumed = adapter.buildArgs({ ...base, team, sessionId: "thread-1" }, "/s.json");
    for (const args of [first, resumed]) {
      expect(args.join(" ")).toContain(overrides.join(" "));
      expect(args.at(-1)).toBe("-");
      expect(args.join(" ")).not.toContain("secret-token-value");
    }
    expect(resumed.slice(0, 5)).toEqual([
      "exec",
      "--sandbox",
      "danger-full-access",
      "resume",
      "thread-1",
    ]);
    expect(adapter.buildArgs(base, "/s.json").join(" ")).not.toContain("mcp_servers");
  });

  it("runs a read-only call with a scratch directory in that directory", () => {
    const request = { ...base, scratchDir: "/runs/r1/scratch/F-1" };
    expect(adapter.buildArgs(request, "/s.json").slice(0, 3)).toEqual([
      "exec",
      "--sandbox",
      "danger-full-access",
    ]);
    expect(adapter.buildArgs(request, "/s.json")).not.toContain(
      "sandbox_workspace_write.exclude_slash_tmp=true",
    );
    expect(adapter.workingDir(request)).toBe("/runs/r1/scratch/F-1");
    expect(adapter.workingDir(base)).toBe("/w");
    expect(adapter.workingDir({ ...base, tools: "write", scratchDir: "/x" })).toBe("/w");
  });

  it("uses Codex's own sandbox when asked", () => {
    expect(ownSandbox.buildArgs(base, "/s").slice(0, 3)).toEqual([
      "exec",
      "--sandbox",
      "read-only",
    ]);
    expect(ownSandbox.buildArgs({ ...base, tools: "write" }, "/s")).toContain("workspace-write");
    const scratch = ownSandbox.buildArgs({ ...base, scratchDir: "/runs/r1/scratch/F-1" }, "/s");
    expect(scratch.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"]);
    expect(scratch).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
  });

  it("puts --sandbox before resume", () => {
    const args = adapter.buildArgs({ ...base, sessionId: "t1" }, "/s.json");
    expect(args.slice(0, 5)).toEqual(["exec", "--sandbox", "danger-full-access", "resume", "t1"]);
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("--full-auto");
  });
});
