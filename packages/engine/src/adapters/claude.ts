// The Claude adapter: `claude -p` with `--output-format stream-json`. Flags
// and output shapes follow the Claude Code headless documentation, checked
// against Claude Code 2.1.310.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageSample, UsageWindow } from "@aio/contracts";
import {
  AUTH_PATTERN,
  CliAdapter,
  detectLimitInText,
  limitFromError,
  epochToIso,
  tail,
  type CallContext,
  type CliAdapterOptions,
} from "./base.js";
import { parseStructured, parseStructuredText } from "./output.js";
import { credentialsFor } from "../process/credentials.js";
import { childEnv } from "../process/env.js";
import { runProcess } from "./process.js";
import { AdapterError, type CliRequest, type CliResult, type CliLimitInfo } from "./types.js";

/** Tools a read-only Claude role gets. */
export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash"];

/** The only commands a read-only role may run through `Bash`. */
export const CLAUDE_READ_ONLY_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git blame *)",
  "Bash(git status *)",
  "Bash(git ls-files *)",
];

export const CLAUDE_WRITE_DENIED_FOR_READ_ONLY = [
  "Edit",
  "Write",
  "NotebookEdit",
  // `git diff`, `log`, and `show` write files with `--output`, and run
  // programs with `--ext-diff` or `--textconv`. A deny wins over the allows.
  "Bash(*--output*)",
  "Bash(*--ext-diff*)",
  "Bash(*--textconv*)",
];

/**
 * The tool lists for a read-only call. With a scratch directory, `Write` is
 * available but allowed only under that directory: `dontAsk` denies every
 * call no allow rule covers. File-writing tools take their permission from
 * `Edit(...)` path rules (a `Write(...)` rule matches nothing), and a path
 * that starts with `//` is absolute. Checked against Claude Code 2.1.310.
 */
export function claudeReadOnlyPolicy(scratchDir?: string): {
  tools: string[];
  allowed: string[];
  disallowed: string[];
} {
  if (!scratchDir) {
    return {
      tools: CLAUDE_READ_ONLY_TOOLS,
      allowed: CLAUDE_READ_ONLY_ALLOWED,
      disallowed: CLAUDE_WRITE_DENIED_FOR_READ_ONLY,
    };
  }
  const dir = scratchDir.replace(/\/+$/, "");
  return {
    tools: [...CLAUDE_READ_ONLY_TOOLS, "Write"],
    allowed: [...CLAUDE_READ_ONLY_ALLOWED, `Edit(/${dir}/**)`],
    disallowed: CLAUDE_WRITE_DENIED_FOR_READ_ONLY.filter((t) => t !== "Write"),
  };
}

export interface ClaudeAdapterOptions extends CliAdapterOptions {
  /**
   * Pass `--bare`, which skips hooks, plugins, and CLAUDE.md discovery. It
   * also skips OAuth, so it works only with `ANTHROPIC_API_KEY`. Defaults to
   * true when the child's environment has that variable and false otherwise.
   */
  bare?: boolean;
  /** Permission mode for `tools: "write"`. Default `bypassPermissions`; the container is the sandbox. */
  writePermissionMode?: "acceptEdits" | "auto" | "bypassPermissions";
  /**
   * Whether Claude Code saves each session under `~/.claude/projects`.
   * Default true, which `sessionId` resumes need. False passes
   * `--no-session-persistence`, so a test leaves no transcript behind.
   */
  persistSessions?: boolean;
}

/** What the adapter learned from one stream. */
export interface ClaudeStreamSummary {
  sessionId: string | null;
  model: string | null;
  samples: UsageSample[];
  /** A `rate_limit_event` whose status was `rejected`. */
  rejected: CliLimitInfo | null;
  /** The `error` code of an API error message, such as `authentication_failed` or `rate_limit`. */
  apiError: string | null;
  apiErrorText: string | null;
  result: Record<string, unknown> | null;
  /** Lines that weren't JSON. */
  badLines: number;
  /** The text of each `tool_result` block marked `is_error`, cut to its last 300 characters. */
  toolErrors?: string[];
}

export class ClaudeAdapter extends CliAdapter {
  readonly vendor = "claude" as const;
  private readonly claudeOptions: ClaudeAdapterOptions;

  constructor(options: ClaudeAdapterOptions = {}) {
    super(options);
    this.claudeOptions = options;
  }

  protected override get account(): string {
    return this.options.account ?? claudeAccount() ?? "claude-default";
  }

  protected versionArgs(): string[] {
    return ["--version"];
  }

  /**
   * The arguments for one call. The prompt goes on stdin. `credentials` are
   * the ones the broker gave for this call: an API key among them means
   * `--bare`.
   */
  buildArgs(req: CliRequest<unknown>, credentials: Record<string, string> = {}): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    const bare =
      this.claudeOptions.bare ??
      Boolean(childEnv("vendor:claude", { ...credentials, ...this.options.env }).ANTHROPIC_API_KEY);
    if (bare) args.push("--bare");
    if (this.claudeOptions.persistSessions === false) args.push("--no-session-persistence");
    if (req.model) args.push("--model", req.model);
    if (req.effort) args.push("--effort", req.effort);
    if (req.maxTurns !== undefined) args.push("--max-turns", String(req.maxTurns));
    if (req.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(req.maxBudgetUsd));
    if (req.sessionId) args.push("--resume", req.sessionId);
    if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
    for (const dir of req.addDirs ?? []) args.push("--add-dir", dir);
    args.push("--json-schema", JSON.stringify(this.jsonSchemaFor(req)));
    if (req.tools === "read-only") {
      const policy = claudeReadOnlyPolicy(req.scratchDir);
      args.push(
        "--tools",
        policy.tools.join(","),
        "--allowedTools",
        policy.allowed.join(","),
        "--disallowedTools",
        policy.disallowed.join(","),
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
      );
    } else {
      args.push("--permission-mode", this.claudeOptions.writePermissionMode ?? "bypassPermissions");
    }
    return args;
  }

  protected async call<T>(req: CliRequest<T>, _ctx: CallContext): Promise<CliResult<T>> {
    const parser = new ClaudeStreamParser(this.account, this.ceiling);
    const credentials = await credentialsFor(`vendor:${this.vendor}`, this.command);
    const result = await runProcess({
      command: this.command,
      args: this.buildArgs(req, credentials),
      credentials,
      cwd: req.cwd,
      input: req.prompt,
      env: this.env,
      envProfile: `vendor:${this.vendor}`,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onLine: (line) => {
        for (const sample of parser.push(line)) req.onUsage?.(sample);
      },
    });
    const summary = parser.summary();
    const failure = this.processFailure(result, req);
    if (failure) throw failure;
    return this.interpret(
      req,
      summary,
      result.stdout,
      result.stderr,
      result.exitCode,
      result.durationMs,
    );
  }

  /** Builds the result or the error from a finished stream. Exposed for fixture tests. */
  interpret<T>(
    req: CliRequest<T>,
    summary: ClaudeStreamSummary,
    stdout: string,
    stderr: string,
    exitCode: number | null,
    durationMs: number,
  ): CliResult<T> {
    const res = summary.result;
    const sessionId = summary.sessionId;
    const resultText = typeof res?.result === "string" ? res.result : "";
    const failed =
      !res || res.is_error === true || (res.subtype !== undefined && res.subtype !== "success");

    if (failed) {
      const errors = Array.isArray(res?.errors) ? (res.errors as unknown[]).join("; ") : "";
      const text = [summary.apiErrorText, resultText, errors, stderr].filter(Boolean).join("\n");
      // Limits come from the CLI's own error channels: the rate-limit event,
      // an API error, the error list, stderr, and the result text only when
      // the CLI marked it an error. A failed turn's text is the model's.
      const errorText = [
        summary.apiError ? summary.apiErrorText : null,
        res?.is_error === true ? resultText : null,
        errors,
        stderr,
      ]
        .filter(Boolean)
        .join("\n");
      const limit =
        summary.rejected ??
        (summary.apiError && /rate_limit|overage|usage/i.test(summary.apiError)
          ? (detectLimitInText(errorText, this.now()) ?? {
              kind: "rate_limit" as const,
              resetAt: null,
              message: errorText.slice(0, 300),
            })
          : detectLimitInText(errorText, this.now()));
      if (limit) {
        throw new AdapterError(
          "claude",
          "limit",
          limit.message || "Claude reported a usage limit.",
          {
            limit,
            exitCode,
            raw: stdout,
            sessionId,
          },
        );
      }
      // Sign-in failures come from the same channels; a failed turn's text is
      // the model's, and a review of auth code says "401 Unauthorized" there.
      const auth = summary.apiError === "authentication_failed" || AUTH_PATTERN.test(errorText);
      const reason = res
        ? `${String(res.subtype)} (${String(res.terminal_reason ?? "unknown")})${text ? `: ${tail(text)}` : ""}`
        : `no result line; exit code ${String(exitCode)}${text ? `: ${tail(text)}` : ""}`;
      throw new AdapterError(
        "claude",
        auth ? "auth" : "process",
        `The Claude call failed: ${reason}`,
        {
          exitCode,
          raw: stdout,
          sessionId,
        },
      );
    }

    const output =
      res.structured_output !== undefined && res.structured_output !== null
        ? parseStructured("claude", req.outputSchema, res.structured_output, stdout, sessionId)
        : parseStructuredText("claude", req.outputSchema, resultText, stdout, sessionId);

    const { tokens, model } = claudeTokens(res, summary.model ?? req.model ?? null);
    return {
      output,
      sessionId,
      model,
      usage: summary.samples,
      tokens,
      costUsd: typeof res.total_cost_usd === "number" ? res.total_cost_usd : undefined,
      premiumRequests: 0,
      raw: stdout,
      durationMs,
      ...(summary.toolErrors?.length ? { toolErrors: summary.toolErrors } : {}),
    };
  }

  detectLimit(error: unknown): CliLimitInfo | null {
    return limitFromError(error, this.now());
  }
}

/** Reads `stream-json` lines one at a time. */
export class ClaudeStreamParser {
  private sessionId: string | null = null;
  private model: string | null = null;
  private readonly samples: UsageSample[] = [];
  private rejected: CliLimitInfo | null = null;
  private apiError: string | null = null;
  private apiErrorText: string | null = null;
  private result: Record<string, unknown> | null = null;
  private badLines = 0;
  private readonly toolErrors: string[] = [];

  constructor(
    private readonly account: string,
    private readonly ceiling: UsageSample["ceiling"],
  ) {}

  /** Consumes one line and returns the usage samples it carried. */
  push(line: string): UsageSample[] {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
      event = parsed as Record<string, unknown>;
    } catch {
      this.badLines += 1;
      return [];
    }
    if (typeof event.session_id === "string" && !this.sessionId) this.sessionId = event.session_id;

    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          if (typeof event.session_id === "string") this.sessionId = event.session_id;
          if (typeof event.model === "string") this.model = event.model;
        }
        return [];
      case "assistant": {
        const message = event.message as Record<string, unknown> | undefined;
        if (typeof message?.model === "string" && message.model !== "<synthetic>")
          this.model = message.model;
        if (typeof event.error === "string") {
          this.apiError = event.error;
          this.apiErrorText = assistantText(message);
        }
        return [];
      }
      case "user":
        this.collectToolErrors(event.message);
        return [];
      case "rate_limit_event":
        return this.rateLimit(event.rate_limit_info);
      case "result":
        this.result = event;
        if (typeof event.session_id === "string") this.sessionId = event.session_id;
        return [];
      default:
        return [];
    }
  }

  summary(): ClaudeStreamSummary {
    return {
      sessionId: this.sessionId,
      model: this.model,
      samples: [...this.samples],
      rejected: this.rejected,
      apiError: this.apiError,
      apiErrorText: this.apiErrorText,
      result: this.result,
      badLines: this.badLines,
      toolErrors: [...this.toolErrors],
    };
  }

  private collectToolErrors(message: unknown): void {
    const content = (message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const part of content as unknown[]) {
      if (!part || typeof part !== "object") continue;
      const block = part as Record<string, unknown>;
      if (block.type !== "tool_result" || block.is_error !== true) continue;
      const text = toolResultText(block.content).trim();
      this.toolErrors.push(text.length > 300 ? text.slice(-300) : text || "A tool failed.");
    }
  }

  private rateLimit(info: unknown): UsageSample[] {
    if (info === null || typeof info !== "object") return [];
    const data = info as Record<string, unknown>;
    const out: UsageSample[] = [];
    const windows = data.unifiedWindows as Record<string, Record<string, unknown>> | undefined;
    const seen = new Set<UsageWindow>();
    if (windows && typeof windows === "object") {
      for (const [name, value] of Object.entries(windows)) {
        const window = CLAUDE_WINDOWS[name];
        if (!window || typeof value?.utilization !== "number") continue;
        seen.add(window);
        out.push(this.sample(window, value.utilization, epochToIso(value.resetsAt)));
      }
    }
    // Older CLIs report one window at the top level.
    const topWindow =
      typeof data.rateLimitType === "string" ? CLAUDE_WINDOWS[data.rateLimitType] : undefined;
    if (topWindow && !seen.has(topWindow) && typeof data.utilization === "number") {
      out.push(this.sample(topWindow, data.utilization, epochToIso(data.resetsAt)));
    }
    if (data.status === "rejected") {
      this.rejected = {
        kind: "usage_limit",
        resetAt: epochToIso(data.resetsAt),
        message: `Claude rejected the call: the ${String(data.rateLimitType ?? "usage")} limit is reached.`,
      };
    }
    this.samples.push(...out);
    return out;
  }

  private sample(window: UsageWindow, utilization: number, resetAt: string | null): UsageSample {
    return {
      vendor: "claude",
      account: this.account,
      window,
      utilization: Math.max(0, utilization),
      spendUsd: null,
      ceiling: this.ceiling,
      resetAt,
      sampleSource: "rate_limit_event",
    };
  }
}

const CLAUDE_WINDOWS: Record<string, UsageWindow | undefined> = {
  five_hour: "5h",
  seven_day: "7d",
};

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      part && typeof part === "object" && "text" in part ? String(part.text) : "",
    )
    .filter(Boolean)
    .join("\n");
}

function assistantText(message: Record<string, unknown> | undefined): string | null {
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((part: unknown) =>
      part && typeof part === "object" && "text" in part ? String(part.text) : "",
    )
    .filter(Boolean);
  return texts.length ? texts.join("\n") : null;
}

/**
 * Totals tokens across `modelUsage`, which covers every model the call used,
 * subagents included. Input counts cache reads and writes, since they count
 * against the plan's limits too.
 */
export function claudeTokens(
  result: Record<string, unknown>,
  fallbackModel: string | null,
): { tokens: { input: number; output: number }; model: string | null } {
  const usageByModel = result.modelUsage as Record<string, Record<string, unknown>> | undefined;
  let input = 0;
  let output = 0;
  let model = fallbackModel;
  let topCost = -1;
  if (usageByModel && typeof usageByModel === "object" && Object.keys(usageByModel).length > 0) {
    for (const [name, u] of Object.entries(usageByModel)) {
      input += num(u.inputTokens) + num(u.cacheReadInputTokens) + num(u.cacheCreationInputTokens);
      output += num(u.outputTokens);
      if (num(u.costUSD) > topCost) {
        topCost = num(u.costUSD);
        model = name;
      }
    }
  } else {
    const u = (result.usage ?? {}) as Record<string, unknown>;
    input =
      num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    output = num(u.output_tokens);
  }
  return { tokens: { input, output }, model };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const lastAccount = new Map<string, string>();

/**
 * The signed-in account's email from `~/.claude.json`, or `null`. Every
 * running `claude` rewrites that file, so a read can catch it half written;
 * a read that fails returns the last email this file gave, which keeps one
 * account's usage samples from splitting under a fallback name.
 */
export function claudeAccount(file = join(homedir(), ".claude.json")): string | null {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      oauthAccount?: { emailAddress?: unknown };
    };
    const email = data.oauthAccount?.emailAddress;
    if (typeof email === "string" && email.length > 0) {
      lastAccount.set(file, email);
      return email;
    }
    return lastAccount.get(file) ?? null;
  } catch {
    return lastAccount.get(file) ?? null;
  }
}
