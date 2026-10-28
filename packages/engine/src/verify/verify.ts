// Verify stage (design.md, pre-push step 5): a disprover from another vendor
// tries to disprove each finding, with a reproduction script where it can,
// and the engine checks whether the flaw exists at the pinned base.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Finding, PolicyFile, Profile, RoleAssignment, Vendor } from "@agentbox/contracts";
import type { AdapterRequest, CommandRunner, VerifyOutput } from "../core.js";
import { policyPromptSection } from "../policy/rules.js";
import { disproverPrompt, type RangeInfo } from "../prompts/templates.js";
import type { Git } from "../range/git.js";

/** The order the engine tries vendors in when it needs another one for a role. */
export const FALLBACK_ORDER: readonly Vendor[] = ["codex", "copilot", "claude"];

/**
 * The vendor that disproves a finding the `reporter` raised. With
 * `crossVendor`, it is never the reporter: the round's disprover when that
 * differs, or the next available vendor in the fallback order. In the
 * `offload` profile, Claude disproves only when no other vendor is available.
 */
export function chooseDisprover(
  reporter: Vendor | null,
  roles: RoleAssignment,
  options: { crossVendor: boolean; available: readonly Vendor[]; profile: Profile },
): Vendor {
  if (!options.crossVendor)
    return reporter && options.available.includes(reporter) ? reporter : roles.disprover;
  if (roles.disprover !== reporter && options.available.includes(roles.disprover))
    return roles.disprover;
  const others = FALLBACK_ORDER.filter((v) => v !== reporter && options.available.includes(v));
  const preferred = options.profile === "offload" ? others.filter((v) => v !== "claude") : others;
  return preferred[0] ?? others[0] ?? roles.disprover;
}

/** A detached checkout of the pinned base in a temporary directory. */
export class BaseWorktree {
  private path: Promise<string> | null = null;

  constructor(
    private readonly git: Git,
    private readonly baseSha: string,
  ) {}

  /** Creates the checkout on first use and returns its path. */
  ensure(): Promise<string> {
    // Parallel disprovers share one checkout, so the promise is the cache.
    this.path ??= (async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentbox-base-"));
      await this.git.addDetachedWorktree(dir, this.baseSha);
      return dir;
    })();
    return this.path;
  }

  async dispose(): Promise<void> {
    if (!this.path) return;
    const pending = this.path;
    this.path = null;
    const path = await pending.catch(() => null);
    if (!path) return;
    await this.git.removeWorktree(path);
    await rm(path, { recursive: true, force: true });
  }
}

export interface ScriptRun {
  exitCode: number;
  timedOut: boolean;
  output: string;
}

/** Runs a reproduction script against `repoDir`. Refuses a path outside the scratch directory. */
export async function runReproScript(
  runner: CommandRunner,
  scratchDir: string,
  script: NonNullable<VerifyOutput["script"]>,
  repoDir: string,
  timeoutMs = 120_000,
): Promise<ScriptRun> {
  const full = resolve(scratchDir, script.path);
  const rel = relative(scratchDir, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`The reproduction script ${script.path} is outside the scratch directory.`);
  }
  const [program, args] = script.interpreter
    ? [script.interpreter, [full, repoDir]]
    : [full, [repoDir]];
  const result = await runner.run(program, args, { cwd: repoDir, timeoutMs });
  const output = `${result.stdout}${result.stderr}`.trim().split("\n").slice(-20).join("\n");
  return { exitCode: result.exitCode, timedOut: result.timedOut, output };
}

export interface VerdictDecision {
  verdict: "confirmed" | "disproved" | "pre-existing";
  verification: "script" | "code-reading";
  introduced: boolean;
  evidence: string;
}

/**
 * Combines the disprover's answer with the engine's own script runs. A
 * script that reproduces at the tip confirms by script; one that also
 * reproduces at the base makes the finding pre-existing.
 */
export function decideVerdict(
  output: VerifyOutput,
  tip: ScriptRun | null,
  base: ScriptRun | null,
): VerdictDecision {
  const parts = [output.evidence.trim()];
  if (output.verdict === "disproved") {
    return {
      verdict: "disproved",
      verification: output.verification,
      introduced: true,
      evidence: parts.join("\n"),
    };
  }
  let verification: "script" | "code-reading" = output.verification;
  let presentAtBase = output.presentAtBase;
  if (tip) {
    const reproduced = tip.exitCode !== 0 && !tip.timedOut;
    parts.push(
      `Engine rerun at tip: exit ${tip.exitCode}${tip.timedOut ? " (timed out)" : ""}.${tip.output ? ` ${tip.output}` : ""}`,
    );
    if (reproduced) {
      verification = "script";
      if (base) {
        const atBase = base.exitCode !== 0 && !base.timedOut;
        parts.push(
          `Engine rerun at base: exit ${base.exitCode}${base.timedOut ? " (timed out)" : ""}.`,
        );
        presentAtBase = atBase;
      }
    } else {
      verification = "code-reading";
      parts.push(
        "The script didn't reproduce the flaw when the engine reran it, so the verdict rests on code reading.",
      );
    }
  }
  if (presentAtBase) {
    return { verdict: "pre-existing", verification, introduced: false, evidence: parts.join("\n") };
  }
  return { verdict: "confirmed", verification, introduced: true, evidence: parts.join("\n") };
}

export interface VerifyDeps {
  runner: CommandRunner;
  range: RangeInfo;
  policy: PolicyFile;
  baseWorktree: BaseWorktree;
  scratchDirFor: (findingId: string) => string;
  timeoutMs: number;
  /**
   * Makes the disprover call under a lease. Returns `null` when the call
   * failed after its retry or the lease was refused for this role.
   */
  callDisprover: (
    vendor: Vendor,
    finding: Finding,
    request: AdapterRequest,
  ) => Promise<{ vendor: Vendor; model: string; output: VerifyOutput } | null>;
}

export interface VerifyResult {
  findingId: string;
  vendor: Vendor;
  model: string;
  decision: VerdictDecision;
  tipRun: ScriptRun | null;
  baseRun: ScriptRun | null;
}

/** Verifies one finding. Returns `null` when no disprover answered. */
export async function verifyFinding(
  finding: Finding,
  vendor: Vendor,
  deps: VerifyDeps,
): Promise<VerifyResult | null> {
  const scratchDir = deps.scratchDirFor(finding.id);
  await mkdir(scratchDir, { recursive: true });
  const baseDir = await deps.baseWorktree.ensure();
  const prompt = disproverPrompt({
    range: deps.range,
    finding,
    scratchDir,
    baseWorktree: baseDir,
    policySection: policyPromptSection(deps.policy, finding.file ? [finding.file] : undefined),
  });
  const answer = await deps.callDisprover(vendor, finding, {
    prompt,
    repoPath: deps.range.repoPath,
    extraDirs: [baseDir],
    scratchDir,
    toolPolicy: "read-only",
    timeoutMs: deps.timeoutMs,
  });
  if (!answer) return null;
  let tipRun: ScriptRun | null = null;
  let baseRun: ScriptRun | null = null;
  if (answer.output.script && answer.output.verdict === "confirmed") {
    try {
      tipRun = await runReproScript(
        deps.runner,
        scratchDir,
        answer.output.script,
        deps.range.repoPath,
      );
      if (tipRun.exitCode !== 0) {
        baseRun = await runReproScript(deps.runner, scratchDir, answer.output.script, baseDir);
      }
    } catch (error) {
      tipRun = {
        exitCode: 0,
        timedOut: false,
        output: `The engine couldn't run the script: ${(error as Error).message}`,
      };
    }
  }
  return {
    findingId: finding.id,
    vendor: answer.vendor,
    model: answer.model,
    decision: decideVerdict(answer.output, tipRun, baseRun),
    tipRun,
    baseRun,
  };
}
