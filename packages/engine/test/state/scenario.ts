// Fake vendor adapters scripted from tools/sample-repo/scenario/bugs.json.
//
// A fake reviewer reports a planted bug when the scenario says its vendor
// finds it in this round and the bug is still present at the tip: its
// reproduction script exits 1, or, without a script, its anchor is in the
// file. The fake disprover confirms planted bugs with their scripts and
// disproves the false positive. The fake fixer applies the prepared
// find-and-replace patches and commits.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Vendor, VendorFinding } from "@agentbox/contracts";
import type {
  AdapterRequest,
  AdapterResult,
  ConfirmOutput,
  ContinueRequest,
  FixOutput,
  HunkVerdict,
  LimitInfo,
  ReviewOutput,
  SweepOutput,
  VendorAdapter,
  VerifyOutput,
} from "../../src/core.js";
import { tempDir } from "../tmp.js";

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DIR = resolve(here, "../../../../tools/sample-repo");
const SCENARIO_DIR = join(SAMPLE_DIR, "scenario");

export interface FixStep {
  file: string;
  find: string;
  replace: string;
}

export interface Bug {
  id: string;
  file: string;
  anchor: string;
  span: number;
  title: string;
  severity: "P1" | "P2" | "P3" | "nit";
  category: string;
  failure_case: string;
  repro: string | null;
  preExisting?: boolean;
  falsePositive?: boolean;
  foundBy: Array<{
    vendor: Vendor | "any";
    round: number;
    via: "review" | "continuation" | "sweep";
  }>;
  fix: FixStep[];
  badFix?: FixStep[];
}

export function loadBugs(): Bug[] {
  return (JSON.parse(readFileSync(join(SCENARIO_DIR, "bugs.json"), "utf8")) as { bugs: Bug[] })
    .bugs;
}

/** Builds the sample repository in a new temporary directory and returns the repo path. */
export function buildSampleRepo(): string {
  const dest = tempDir("agentbox-sample-");
  execFileSync("bash", [join(SAMPLE_DIR, "build.sh"), dest], { stdio: "pipe" });
  return join(dest, "repo");
}

/** True when the bug is present in `repoDir`. */
export function bugPresent(bug: Bug, repoDir: string): boolean {
  if (bug.repro) {
    const r = spawnSync("python3", [join(SCENARIO_DIR, "repro", bug.repro), repoDir], {
      cwd: repoDir,
    });
    return r.status === 1;
  }
  try {
    return readFileSync(join(repoDir, bug.file), "utf8").includes(bug.anchor);
  } catch {
    return false;
  }
}

function anchorLine(bug: Bug, repoDir: string): number {
  const lines = readFileSync(join(repoDir, bug.file), "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(bug.anchor.split("\n")[0] as string));
  return i < 0 ? 1 : i + 1;
}

export function toVendorFinding(bug: Bug, repoDir: string): VendorFinding {
  const line = anchorLine(bug, repoDir);
  return {
    severity: bug.severity,
    title: bug.title,
    file: bug.file,
    lines: [line, line + bug.span - 1],
    failure_case: bug.failure_case,
    category: bug.category,
    introduced: !bug.preExisting,
    verdict: "pending",
  };
}

export class FakeLimitError extends Error {
  constructor(readonly resetAt: string) {
    super("usage limit reached");
  }
}

interface Session {
  vendor: Vendor;
  files: string[];
  round: number;
  reported: Set<string>;
}

export interface CallRecord {
  vendor: Vendor;
  method: string;
  round: number | null;
  prompt: string;
}

export interface ScenarioOptions {
  /** Apply a bug's `badFix` on the first fix attempt, so the gate catches a regression. */
  badFixes?: boolean;
  /** Extra bug ids a vendor reports in a round, present or not, with the same title. */
  forceReports?: Array<{ vendor: Vendor; round: number; bugId: string }>;
  /** Calls that never answer: the n-th call (1-based) of a method. */
  hang?: { method: keyof VendorAdapter; nth: number };
  /** Calls that throw a usage limit: the n-th call of a method on a vendor. */
  limit?: { vendor: Vendor; method: keyof VendorAdapter; nth: number; resetAt: string };
}

/** Shared state of every fake vendor in one test. */
export class Scenario {
  readonly bugs = loadBugs();
  readonly calls: CallRecord[] = [];
  private sessions = new Map<string, Session>();
  private counts = new Map<string, number>();
  private sessionSeq = 0;
  /** Round the reviewer prompts named last; the fixer and verifier inherit it. */
  currentRound = 0;

  constructor(readonly options: ScenarioOptions = {}) {}

  adapters(
    vendors: readonly Vendor[] = ["claude", "codex", "copilot"],
  ): Partial<Record<Vendor, VendorAdapter>> {
    const out: Partial<Record<Vendor, VendorAdapter>> = {};
    for (const v of vendors) out[v] = new ScenarioAdapter(v, this);
    return out;
  }

  count(method: string, vendor?: Vendor): number {
    return this.calls.filter((c) => c.method === method && (!vendor || c.vendor === vendor)).length;
  }

  /** Records a call and applies the hang and limit options. */
  async enter(vendor: Vendor, method: keyof VendorAdapter, prompt: string): Promise<void> {
    const round = /in round (\d+) of an automated review/.exec(prompt);
    if (round) this.currentRound = Number(round[1]);
    this.calls.push({ vendor, method, round: round ? Number(round[1]) : null, prompt });
    const key = `${method}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    const vkey = `${vendor}:${method}`;
    const vn = (this.counts.get(vkey) ?? 0) + 1;
    this.counts.set(vkey, vn);
    if (this.options.hang && this.options.hang.method === method && this.options.hang.nth === n) {
      await new Promise(() => undefined);
    }
    const limit = this.options.limit;
    if (limit && limit.vendor === vendor && limit.method === method && limit.nth === vn) {
      throw new FakeLimitError(limit.resetAt);
    }
  }

  newSession(s: Session): string {
    this.sessionSeq += 1;
    const id = `${s.vendor}-session-${this.sessionSeq}`;
    this.sessions.set(id, s);
    return id;
  }

  session(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  findsIn(
    bug: Bug,
    vendor: Vendor,
    round: number,
    via: "review" | "continuation" | "sweep",
  ): boolean {
    return bug.foundBy.some(
      (f) => f.via === via && (f.vendor === vendor || f.vendor === "any") && f.round <= round,
    );
  }

  bugByTitle(title: string): Bug | undefined {
    return this.bugs.find((b) => b.title === title.trim());
  }
}

function parseFiles(prompt: string): string[] {
  const m = /## Files\n\n([\s\S]*?)\n\n/.exec(prompt);
  return m
    ? (m[1] as string)
        .split("\n")
        .map((l) => l.replace(/^- /, "").trim())
        .filter(Boolean)
    : [];
}

function parseHunks(
  prompt: string,
): Array<{ id: string; file: string; start: number; end: number }> {
  return [...prompt.matchAll(/^- (G\d+-H\d+): (\S+) lines (\d+)-(\d+)$/gm)].map((m) => ({
    id: m[1] as string,
    file: m[2] as string,
    start: Number(m[3]),
    end: Number(m[4]),
  }));
}

function ledgerFor(
  hunks: ReturnType<typeof parseHunks>,
  findings: readonly VendorFinding[],
): HunkVerdict[] {
  return hunks.map((h) => {
    const hit = findings.some(
      (f) =>
        f.file === h.file && f.lines[0] <= Math.max(h.end, h.start + 1) && f.lines[1] >= h.start,
    );
    return {
      hunkId: h.id,
      verdict: hit ? "findings" : "sound",
      reason: hit ? "has findings" : "examined, sound",
    };
  });
}

function result<T>(
  vendor: Vendor,
  prompt: string,
  output: T,
  sessionId: string | null = null,
): AdapterResult<T> {
  return {
    output,
    model: `${vendor}-fake`,
    sessionId,
    tokens: { in: Math.ceil(prompt.length / 4), out: 200 },
    usage:
      vendor === "claude"
        ? [
            {
              vendor: "claude",
              account: "dev@example.com",
              window: "5h",
              utilization: 0.1,
              spendUsd: null,
              resetAt: null,
              sampleSource: "rate_limit_event",
            },
          ]
        : [],
    premiumRequests: vendor === "copilot" ? 1 : 0,
    costEstimate: 0.01,
  };
}

export class ScenarioAdapter implements VendorAdapter {
  constructor(
    readonly vendor: Vendor,
    private readonly scenario: Scenario,
  ) {}

  async review(request: AdapterRequest): Promise<AdapterResult<ReviewOutput>> {
    await this.scenario.enter(this.vendor, "review", request.prompt);
    const round = this.scenario.currentRound;
    const files = parseFiles(request.prompt);
    const hunks = parseHunks(request.prompt);
    const repo = request.repoPath;
    const found = this.scenario.bugs.filter(
      (b) =>
        files.includes(b.file) &&
        this.scenario.findsIn(b, this.vendor, round, "review") &&
        bugPresent(b, repo),
    );
    for (const forced of this.scenario.options.forceReports ?? []) {
      const bug = this.scenario.bugs.find((b) => b.id === forced.bugId);
      if (
        bug &&
        forced.vendor === this.vendor &&
        forced.round === round &&
        files.includes(bug.file) &&
        !found.includes(bug)
      ) {
        found.push(bug);
      }
    }
    const findings = found.map((b) => toVendorFinding(b, repo));
    let ledger = ledgerFor(hunks, findings);
    // The codex reviewer of the inventory group forgets one hunk in round 1.
    if (this.vendor === "codex" && round === 1 && files.includes("shop/inventory.py"))
      ledger = ledger.slice(0, -1);
    const sessionId = this.scenario.newSession({
      vendor: this.vendor,
      files,
      round,
      reported: new Set(found.map((b) => b.id)),
    });
    return result(this.vendor, request.prompt, { findings, ledger }, sessionId);
  }

  async continueReview(request: ContinueRequest): Promise<AdapterResult<ReviewOutput>> {
    await this.scenario.enter(this.vendor, "continueReview", request.prompt);
    const session = this.scenario.session(request.sessionId);
    if (!session) throw new Error(`unknown session ${request.sessionId}`);
    if (request.prompt.startsWith("Your ledger has no verdict")) {
      const hunks = parseHunks(request.prompt);
      return result(
        this.vendor,
        request.prompt,
        { findings: [], ledger: ledgerFor(hunks, []) },
        request.sessionId,
      );
    }
    const found = this.scenario.bugs.filter(
      (b) =>
        session.files.includes(b.file) &&
        !session.reported.has(b.id) &&
        this.scenario.findsIn(b, this.vendor, session.round, "continuation") &&
        bugPresent(b, request.repoPath),
    );
    for (const b of found) session.reported.add(b.id);
    const findings = found.map((b) => toVendorFinding(b, request.repoPath));
    return result(this.vendor, request.prompt, { findings, ledger: [] }, request.sessionId);
  }

  async sweep(request: AdapterRequest): Promise<AdapterResult<SweepOutput>> {
    await this.scenario.enter(this.vendor, "sweep", request.prompt);
    const round = this.scenario.currentRound;
    const found = this.scenario.bugs.filter(
      (b) =>
        this.scenario.findsIn(b, this.vendor, round, "sweep") && bugPresent(b, request.repoPath),
    );
    return result(this.vendor, request.prompt, {
      findings: found.map((b) => toVendorFinding(b, request.repoPath)),
    });
  }

  async verify(request: AdapterRequest): Promise<AdapterResult<VerifyOutput>> {
    await this.scenario.enter(this.vendor, "verify", request.prompt);
    const title = /^Title: (.+)$/m.exec(request.prompt)?.[1] ?? "";
    const bug = this.scenario.bugByTitle(title);
    if (!bug || bug.falsePositive) {
      return result(this.vendor, request.prompt, {
        verdict: "disproved",
        verification: "code-reading",
        evidence: "The code rejects this input before it reaches the line in question.",
        presentAtBase: false,
        script: null,
      });
    }
    if (bug.repro && request.scratchDir) {
      mkdirSync(request.scratchDir, { recursive: true });
      copyFileSync(join(SCENARIO_DIR, "repro", bug.repro), join(request.scratchDir, bug.repro));
      return result(this.vendor, request.prompt, {
        verdict: "confirmed",
        verification: "script",
        evidence: `${bug.repro} reproduces the failure.`,
        presentAtBase: false,
        script: { path: bug.repro, interpreter: "python3" },
      });
    }
    return result(this.vendor, request.prompt, {
      verdict: "confirmed",
      verification: "code-reading",
      evidence: "The default argument is evaluated once, so every call shares it.",
      presentAtBase: false,
      script: null,
    });
  }

  async fix(request: AdapterRequest): Promise<AdapterResult<FixOutput>> {
    await this.scenario.enter(this.vendor, "fix", request.prompt);
    const retry = request.prompt.includes("## Gate failure");
    const items = [...request.prompt.matchAll(/^- (F-\d+) \[(?:P1|P2|P3|nit)\] (.+?) \(/gm)].map(
      (m) => ({
        id: m[1] as string,
        title: m[2] as string,
      }),
    );
    const fixed: string[] = [];
    const notFixed: Array<{ id: string; reason: string }> = [];
    for (const item of items) {
      const bug = this.scenario.bugByTitle(item.title);
      const steps = bug
        ? !retry && this.scenario.options.badFixes && bug.badFix
          ? bug.badFix
          : bug.fix
        : [];
      if (!bug || steps.length === 0) {
        notFixed.push({ id: item.id, reason: "Not a defect in this code." });
        continue;
      }
      for (const step of steps) {
        const path = join(request.repoPath, step.file);
        const text = readFileSync(path, "utf8");
        if (text.includes(step.find)) writeFileSync(path, text.replace(step.find, step.replace));
      }
      fixed.push(item.id);
    }
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: request.repoPath,
      encoding: "utf8",
    });
    if (status.trim() !== "") {
      execFileSync("git", ["add", "-A"], { cwd: request.repoPath });
      execFileSync("git", ["commit", "-q", "-m", `Fix ${fixed.join(", ")}`], {
        cwd: request.repoPath,
      });
    }
    return result(this.vendor, request.prompt, {
      fixed,
      notFixed,
      summary: `Fixed ${fixed.length}.`,
    });
  }

  async confirm(request: AdapterRequest): Promise<AdapterResult<ConfirmOutput>> {
    await this.scenario.enter(this.vendor, "confirm", request.prompt);
    return result(this.vendor, request.prompt, { incomplete: [], findings: [] });
  }

  detectLimit(error: unknown): LimitInfo | null {
    return error instanceof FakeLimitError
      ? { resetAt: error.resetAt, message: error.message }
      : null;
  }
}
