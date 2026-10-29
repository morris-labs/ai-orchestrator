// The Copilot adapter: `copilot -p` in headless mode. The Copilot CLI isn't
// installed where this was written; every flag and output shape it relies on
// is listed, with its source, in docs/v4/copilot-cli-assumptions.md.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliAdapter,
  detectLimitInText,
  limitFromError,
  parseResetTime,
  type CallContext,
  type CliAdapterOptions,
} from "./base.js";
import { parseStructuredText } from "./output.js";
import { copilotTokenProblem } from "../process/env.js";
import { runProcess } from "./process.js";
import { AdapterError, type CliRequest, type CliResult, type CliLimitInfo } from "./types.js";

/**
 * Shell commands a read-only Copilot role may run. `git diff`, `log`, and
 * `show` aren't here: they write files with `--output`, and Copilot's
 * documented patterns match only a command's start, so they can't allow the
 * command and deny the option. The prompt carries the diff instead.
 */
export const COPILOT_READ_ONLY_ALLOW = [
  "read",
  "shell(git blame:*)",
  "shell(git status:*)",
  "shell(git ls-files:*)",
];

/**
 * Denied for read-only roles. A deny wins over any allow. Copilot's
 * documentation doesn't say whether `write(PATH)` matches by path, so a
 * read-only call gets no write access at all, scratch directory included: a
 * Copilot disprover returns its reproduction script in `script.content`.
 */
export const COPILOT_READ_ONLY_DENY = ["write"];

/**
 * Premium-request multipliers from GitHub's legacy annual-plan table. A
 * model that isn't listed counts as 1. Since 2026-06-01 most plans pay in AI
 * credits instead; the adapter prefers what the CLI reports.
 */
export const COPILOT_PREMIUM_MULTIPLIERS: Record<string, number> = {
  "claude-haiku-4.5": 0.33,
  "claude-sonnet-4.6": 9,
  "claude-opus-4.8": 27,
  "gemini-3-pro": 6,
  "gpt-5.1": 3,
  "gpt-5.3-codex": 6,
  "gpt-5.1-codex-mini": 0.33,
  "mai-code-1.1-flash": 0.25,
};

/** Automatic model selection is billed 10% below the chosen model's rate. */
export const COPILOT_AUTO_DISCOUNT = 0.9;

/** US dollars per premium request, used only when the CLI reports neither credits nor cost. */
export const COPILOT_USD_PER_PREMIUM_REQUEST = 0.04;

/** US dollars per AI credit. */
export const COPILOT_USD_PER_AI_CREDIT = 0.01;

/** Prompts longer than this go through a file, to stay under the kernel's argument limit. */
export const COPILOT_MAX_PROMPT_ARG = 100_000;

export interface CopilotAdapterOptions extends CliAdapterOptions {
  /** `json` reads the JSONL event stream; `text` reads plain stdout. Default `json`. */
  outputFormat?: "json" | "text";
  /** Overrides or extends `COPILOT_PREMIUM_MULTIPLIERS`. */
  premiumMultipliers?: Record<string, number>;
}

export interface CopilotRunSummary {
  sessionId: string | null;
  model: string | null;
  /** The last assistant message. */
  text: string | null;
  tokens: { input: number; output: number };
  premiumRequests: number | null;
  aiCredits: number | null;
  costUsd: number | null;
  error: { type: string | null; code: string | null; message: string } | null;
  /** Tool calls that reported `success: false`, from `tool.execution_complete`. */
  toolErrors: string[];
}

export class CopilotAdapter extends CliAdapter {
  readonly vendor = "copilot" as const;
  private readonly copilotOptions: CopilotAdapterOptions;

  constructor(options: CopilotAdapterOptions = {}) {
    super(options);
    this.copilotOptions = options;
  }

  protected versionArgs(): string[] {
    return ["--version"];
  }

  /** The full prompt: the system prompt, the task, and the output instructions. */
  buildPrompt(req: CliRequest<unknown>): string {
    const schema = JSON.stringify(this.jsonSchemaFor(req));
    return [
      req.systemPrompt,
      req.prompt,
      "Answer with exactly one JSON value that matches the following JSON Schema, " +
        "and nothing else: no prose before or after it and no code fence.",
      schema,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  buildArgs(
    req: CliRequest<unknown>,
    prompt: string,
    sessionId: string,
    promptFile?: string,
  ): string[] {
    const args: string[] = [];
    if (promptFile) {
      args.push(
        "-p",
        `Read the file ${promptFile} and follow the instructions in it exactly. Its last part says how to format your answer.`,
        "--add-dir",
        join(promptFile, ".."),
      );
    } else {
      args.push("-p", prompt);
    }
    for (const dir of req.addDirs ?? []) args.push("--add-dir", dir);
    if (this.copilotOptions.outputFormat !== "text") args.push("--output-format", "json");
    args.push("--no-color", "--no-ask-user", "--model", req.model ?? "auto");
    if (req.effort) args.push("--effort", req.effort);
    if (req.sessionId) args.push(`--resume=${req.sessionId}`);
    else args.push("--session-id", sessionId);
    if (req.tools === "write") {
      args.push("--allow-all-tools");
    } else {
      const allow = promptFile
        ? [...COPILOT_READ_ONLY_ALLOW, `read(${promptFile})`]
        : COPILOT_READ_ONLY_ALLOW;
      for (const pattern of allow) args.push("--allow-tool", pattern);
      for (const pattern of COPILOT_READ_ONLY_DENY) args.push("--deny-tool", pattern);
    }
    return args;
  }

  protected async call<T>(req: CliRequest<T>, _ctx: CallContext): Promise<CliResult<T>> {
    const prompt = this.buildPrompt(req);
    const sessionId = req.sessionId ?? randomUUID();
    let dir: string | undefined;
    let promptFile: string | undefined;
    if (Buffer.byteLength(prompt) > COPILOT_MAX_PROMPT_ARG) {
      dir = mkdtempSync(join(tmpdir(), "agentbox-copilot-"));
      promptFile = join(dir, "prompt.md");
      writeFileSync(promptFile, prompt);
    }
    try {
      const result = await runProcess({
        command: this.command,
        args: this.buildArgs(req, prompt, sessionId, promptFile),
        cwd: req.cwd,
        env: this.options.env,
        envProfile: `vendor:${this.vendor}`,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
      });
      const failure = this.processFailure(result, req);
      if (failure) throw failure;

      const summary =
        this.copilotOptions.outputFormat === "text"
          ? parseCopilotText(result.stdout, result.stderr)
          : parseCopilotJson(result.stdout, result.stderr);
      const session = summary.sessionId ?? sessionId;

      if (summary.error) {
        const limit = copilotErrorLimit(summary.error, this.now());
        if (limit) {
          throw new AdapterError("copilot", "limit", limit.message, {
            limit,
            exitCode: result.exitCode,
            raw: result.stdout,
            sessionId: session,
          });
        }
      }
      if (result.exitCode !== 0 || summary.error || summary.text === null) {
        throw this.signInFailure(
          this.exitFailure(
            result,
            session,
            summary.error?.message ?? (summary.text === null ? "Copilot returned no answer." : ""),
          ),
          `${summary.error?.message ?? ""}\n${result.stderr}`,
        );
      }

      const output = parseStructuredText(
        "copilot",
        req.outputSchema,
        summary.text,
        result.stdout,
        session,
      );
      const model = summary.model ?? req.model ?? null;
      const premiumRequests =
        summary.premiumRequests ??
        this.estimatePremiumRequests(model, req.model === undefined || req.model === "auto");
      const costUsd =
        summary.costUsd ??
        (summary.aiCredits !== null
          ? summary.aiCredits * COPILOT_USD_PER_AI_CREDIT
          : premiumRequests * COPILOT_USD_PER_PREMIUM_REQUEST);
      return {
        output,
        sessionId: session,
        model,
        usage: [],
        tokens: summary.tokens,
        costUsd,
        premiumRequests,
        ...(summary.aiCredits !== null ? { aiCredits: summary.aiCredits } : {}),
        ...(summary.toolErrors.length > 0 ? { toolErrors: summary.toolErrors } : {}),
        raw: result.stdout,
        durationMs: result.durationMs,
      };
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Turns a failure that a token caused into a setup error that says what to
   * do. Copilot refuses a classic token, and the engine drops one from
   * Copilot's environment, so a sign-in failure with only a classic token
   * around means Copilot has neither its own sign-in nor a usable token.
   */
  signInFailure(error: AdapterError, text: string): AdapterError {
    if (error.kind === "limit") return error;
    const problem = copilotTokenProblem(process.env, this.options.env);
    const refused = CLASSIC_TOKEN_REFUSED.test(text);
    if (!refused && !(problem && error.kind === "auth")) return error;
    const advice =
      problem ??
      "The Copilot CLI refuses classic personal access tokens (ghp_). Sign in to Copilot inside the container with `copilot` and `/login`, or set COPILOT_GITHUB_TOKEN to a fine-grained token with the Copilot Requests permission.";
    return new AdapterError("copilot", "auth", `Copilot can't sign in. ${advice}`, {
      exitCode: error.exitCode,
      raw: error.raw,
      sessionId: error.sessionId,
      cause: error,
    });
  }

  /** One call's premium requests: the model's multiplier, less the automatic-selection discount. */
  estimatePremiumRequests(model: string | null, automatic: boolean): number {
    const table = { ...COPILOT_PREMIUM_MULTIPLIERS, ...this.copilotOptions.premiumMultipliers };
    const key = (model ?? "").toLowerCase().replace(/\s+/g, "-");
    const multiplier = table[key] ?? 1;
    return round(multiplier * (automatic ? COPILOT_AUTO_DISCOUNT : 1));
  }

  detectLimit(error: unknown): CliLimitInfo | null {
    return limitFromError(error, this.now());
  }
}

/** The Copilot CLI's refusal of a classic token. */
const CLASSIC_TOKEN_REFUSED = /classic personal access tokens?|\(ghp_\)/i;

/** Maps a `session.error` to a limit, by its `errorType` first and its text second. */
export function copilotErrorLimit(
  error: NonNullable<CopilotRunSummary["error"]>,
  now: Date,
): CliLimitInfo | null {
  const resetAt = parseResetTime(error.message, now);
  if (error.type === "quota") {
    if (error.code === "billing_not_configured") return null;
    return {
      kind: "usage_limit",
      resetAt,
      message: error.message || "Copilot quota exceeded.",
    };
  }
  if (error.type === "rate_limit") {
    const weekly = error.code === "user_weekly_rate_limited";
    return {
      kind: weekly ? "usage_limit" : "rate_limit",
      resetAt,
      message: error.message || "Copilot rate limit reached.",
    };
  }
  return detectLimitInText(error.message, now);
}

function emptySummary(): CopilotRunSummary {
  return {
    sessionId: null,
    model: null,
    text: null,
    tokens: { input: 0, output: 0 },
    premiumRequests: null,
    aiCredits: null,
    costUsd: null,
    error: null,
    toolErrors: [],
  };
}

/** Parses `--output-format json` output: one `{ type, data }` event per line. */
export function parseCopilotJson(stdout: string, stderr = ""): CopilotRunSummary {
  const s = emptySummary();
  let jsonLines = 0;
  // `assistant.usage` carries both directions; `assistant.message` only output.
  let sawUsage = false;
  const usage = { input: 0, output: 0 };
  let messageOutput = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event.type !== "string") continue;
    jsonLines += 1;
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "session.start":
        if (typeof data.sessionId === "string") s.sessionId = data.sessionId;
        if (typeof data.selectedModel === "string") s.model = data.selectedModel;
        break;
      case "assistant.message":
        if (typeof data.content === "string" && data.content.trim()) s.text = data.content;
        if (typeof data.model === "string") s.model = data.model;
        messageOutput += num(data.outputTokens);
        break;
      case "assistant.usage":
        sawUsage = true;
        usage.input += num(data.inputTokens);
        usage.output += num(data.outputTokens);
        if (typeof data.cost === "number") s.costUsd = (s.costUsd ?? 0) + data.cost;
        if (typeof data.model === "string") s.model = data.model;
        break;
      case "session.shutdown":
        if (typeof data.totalPremiumRequests === "number")
          s.premiumRequests = data.totalPremiumRequests;
        break;
      case "tool.execution_complete":
        if (data.success === false) {
          const error = data.error as { message?: unknown } | undefined;
          const text =
            typeof error?.message === "string" ? error.message.trim() : "A tool call failed.";
          s.toolErrors.push(text.length > 300 ? text.slice(-300) : text);
        }
        break;
      case "session.error":
        s.error = {
          type: typeof data.errorType === "string" ? data.errorType : null,
          code: typeof data.errorCode === "string" ? data.errorCode : null,
          message: typeof data.message === "string" ? data.message : "Copilot reported an error.",
        };
        break;
      case "result": {
        if (typeof event.sessionId === "string") s.sessionId = event.sessionId;
        const usage = (event.usage ?? {}) as Record<string, unknown>;
        if (typeof usage.premiumRequests === "number") s.premiumRequests = usage.premiumRequests;
        break;
      }
      default:
        break;
    }
  }
  // An older CLI without JSON output prints plain text instead.
  if (jsonLines === 0) return parseCopilotText(stdout, stderr);
  s.tokens = sawUsage ? usage : { input: 0, output: messageOutput };
  applyExitSummary(s, stderr);
  return s;
}

/** Parses plain `copilot -p` output: the answer on stdout and the exit summary after it or on stderr. */
export function parseCopilotText(stdout: string, stderr = ""): CopilotRunSummary {
  const s = emptySummary();
  const { answer, summary } = splitExitSummary(stdout);
  s.text = answer.trim() ? answer : null;
  applyExitSummary(s, `${summary}\n${stderr}`);
  const errorLine = /^(?:error|✗)[:\s].*$/im.exec(stderr);
  if (errorLine && s.text === null)
    s.error = { type: null, code: null, message: errorLine[0].trim() };
  return s;
}

const SUMMARY_START =
  /^\s*(?:Total usage est:|Changes\s{2,}|AI Credits\s|Total duration|Usage by model:|Tokens\s{2,}|Resume\s{2,})/m;

function splitExitSummary(text: string): { answer: string; summary: string } {
  const match = SUMMARY_START.exec(text);
  if (!match) return { answer: text, summary: "" };
  return { answer: text.slice(0, match.index), summary: text.slice(match.index) };
}

/** Reads the exit summary's usage lines, in both the pre-2026 and the AI-credits formats. */
function applyExitSummary(s: CopilotRunSummary, text: string): void {
  const premium = /Total usage est:\s*([\d.]+)\s*Premium requests?/i.exec(text);
  if (premium?.[1] && s.premiumRequests === null) s.premiumRequests = Number(premium[1]);
  const credits = /AI Credits\s+([\d.]+)/i.exec(text);
  if (credits?.[1]) s.aiCredits = Number(credits[1]);
  if (s.tokens.input === 0) {
    const arrows = /Tokens\s+↑\s*([\d.]+[kKmM]?).*?↓\s*([\d.]+[kKmM]?)/.exec(text);
    if (arrows?.[1] && arrows[2]) {
      s.tokens = { input: count(arrows[1]), output: count(arrows[2]) };
    } else {
      const totals = { input: 0, output: 0 };
      for (const m of text.matchAll(/([\d.]+[kKmM]?) input, ([\d.]+[kKmM]?) output/g)) {
        totals.input += count(m[1] ?? "0");
        totals.output += count(m[2] ?? "0");
      }
      if (totals.input > 0) s.tokens = totals;
    }
  }
  const resume = /copilot --resume[= ]([0-9a-f-]{36})/i.exec(text);
  if (resume?.[1] && !s.sessionId) s.sessionId = resume[1];
}

/** "51.0k" to 51000. */
export function count(text: string): number {
  const m = /^([\d.]+)([kKmM]?)$/.exec(text.trim());
  if (!m?.[1]) return 0;
  const scale = m[2]?.toLowerCase() === "k" ? 1000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return Math.round(Number(m[1]) * scale);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
