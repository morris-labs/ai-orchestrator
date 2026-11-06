// Verify stage (design.md, pre-push step 5): a disprover from another vendor
// tries to disprove each finding, with a reproduction script where it can,
// and the engine checks whether the flaw exists at the pinned base.
import { lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Finding, PolicyFile, Profile, RoleAssignment, Vendor } from "@aio/contracts";
import { VENDOR_ROLES } from "@aio/contracts";
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
  const others = FALLBACK_ORDER.filter(
    (v) => v !== reporter && options.available.includes(v) && VENDOR_ROLES[v].includes("disprover"),
  );
  const preferred = options.profile === "offload" ? others.filter((v) => v !== "claude") : others;
  return preferred[0] ?? others[0] ?? roles.disprover;
}

/** Where a run's base checkout lives: a temporary directory named after the run. */
export function baseWorktreePath(runId: string): string {
  return join(tmpdir(), `aio-base-${runId}`);
}

/**
 * Removes a base checkout that an earlier engine left behind, and its entry
 * in `git worktree list`. Never rejects.
 */
export async function removeBaseWorktree(git: Git, path: string): Promise<void> {
  try {
    await git.removeWorktree(path);
  } catch {
    // Nothing registered there.
  }
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * A detached checkout of the pinned base. The directory is named after the
 * run, so an engine that restarts finds and removes what a crash left.
 */
export class BaseWorktree {
  private path: Promise<string> | null = null;
  private disposed = false;

  constructor(
    private readonly git: Git,
    private readonly baseSha: string,
    private readonly dir: string = join(tmpdir(), `aio-base-${process.pid}-${Date.now()}`),
  ) {}

  /** Creates the checkout on first use and returns its path. */
  ensure(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("The base checkout was already removed."));
    // Parallel disprovers share one checkout, so the promise is the cache.
    this.path ??= (async () => {
      await removeBaseWorktree(this.git, this.dir);
      await mkdir(dirname(this.dir), { recursive: true });
      try {
        await this.git.addDetachedWorktree(this.dir, this.baseSha);
      } catch (error) {
        await removeBaseWorktree(this.git, this.dir);
        throw error;
      }
      return this.dir;
    })();
    // A failed checkout isn't cached, so the next call tries again.
    this.path.catch(() => {
      this.path = null;
    });
    return this.path;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (!this.path) return;
    const pending = this.path;
    this.path = null;
    const path = await pending.catch(() => null);
    if (!path) return;
    await removeBaseWorktree(this.git, path);
  }
}

export interface ScriptRun {
  exitCode: number;
  timedOut: boolean;
  output: string;
  /** True when the script never ran: missing, not executable, or no interpreter. */
  notStarted?: boolean;
  /** The signal that killed the script, if any. */
  signal?: string | null;
}

/** The exit code a reproduction script uses when the flaw reproduces. */
export const REPRODUCED_EXIT_CODE = 1;

/**
 * Text that an interpreter prints when the script itself failed rather than
 * reporting the flaw: a missing file, a syntax error, an uncaught exception.
 */
const SCRIPT_FAILURE_PATTERN =
  /Traceback \(most recent call last\)|SyntaxError|can't open file|No such file or directory|command not found|cannot find module|ModuleNotFoundError|ImportError|Permission denied|Uncaught |ReferenceError|TypeError: .* is not a function|bad interpreter/i;

/**
 * The last line of a Python traceback for a failed `assert`: the script ran
 * and its own check found the flaw, so the traceback isn't a crash.
 */
const PYTHON_ASSERTION = /(?:^|\n)AssertionError(?::[^\n]*)?$/;

/**
 * What one run of a reproduction script shows: the flaw `reproduced`, the
 * run was `clean`, or the script `failed` to run at all (missing, not
 * executable, timed out, killed by a signal, crashed, or exited with a code
 * other than 0 or 1). A failed run proves nothing either way. A Python
 * script that exits 1 on a failed `assert` reproduced the flaw.
 */
export function classifyRun(run: ScriptRun): "reproduced" | "clean" | "failed" {
  if (run.notStarted || run.timedOut || run.signal) return "failed";
  if (run.exitCode === 126 || run.exitCode === 127) return "failed";
  if (run.exitCode === 0) return "clean";
  if (run.exitCode !== REPRODUCED_EXIT_CODE) return "failed";
  if (PYTHON_ASSERTION.test(run.output.trimEnd())) return "reproduced";
  return SCRIPT_FAILURE_PATTERN.test(run.output) ? "failed" : "reproduced";
}

function failedRun(message: string): ScriptRun {
  return { exitCode: 127, timedOut: false, output: message, notStarted: true };
}

/**
 * Runs a reproduction script against `repoDir`, which must be a checkout the
 * engine owns: the script is repository code with no guard around it.
 * Refuses a path outside the scratch directory, symbolic links included.
 * Writes `script.content` to the path when the agent couldn't write the file
 * itself. A script that doesn't exist comes back as a run that never
 * started. `signal` kills the script's process group, as a cancel does.
 */
export async function runReproScript(
  runner: CommandRunner,
  scratchDir: string,
  script: NonNullable<VerifyOutput["script"]>,
  repoDir: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<ScriptRun> {
  const full = resolve(scratchDir, script.path);
  if (!inside(scratchDir, full)) {
    throw new Error(`The reproduction script ${script.path} is outside the scratch directory.`);
  }
  if (script.content && !(await present(full))) {
    await writeInside(scratchDir, full, script.content);
  }
  if (!(await exists(full))) {
    return failedRun(
      `The reproduction script ${script.path} doesn't exist in the scratch directory.`,
    );
  }
  const real = await realpath(full);
  if (!inside(await realpath(scratchDir), real)) {
    throw new Error(`The reproduction script ${script.path} links outside the scratch directory.`);
  }
  const [program, args] = script.interpreter
    ? [script.interpreter, [real, repoDir]]
    : [real, [repoDir]];
  const result = await runner.run(program, args, {
    cwd: repoDir,
    timeoutMs,
    envProfile: "untrusted",
    ...(signal ? { signal } : {}),
  });
  const output = `${result.stdout}${result.stderr}`.trim().split("\n").slice(-20).join("\n");
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output,
    notStarted: result.notStarted ?? false,
    signal: result.signal ?? null,
  };
}

/** Throws when the run was cancelled, so a killed script never becomes a verdict. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("The run was cancelled during a reproduction script.");
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** True when anything, a dangling symbolic link included, is at `path`. */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes `content` to `full`, a path inside `scratchDir`, without following
 * a symbolic link: each directory on the way must be a real directory, and
 * the `wx` flag refuses a file or link already at `full`. A link planted in
 * the scratch directory can't send the write outside it.
 */
async function writeInside(scratchDir: string, full: string, content: string): Promise<void> {
  const parts = relative(scratchDir, dirname(full)).split(sep).filter(Boolean);
  let dir = scratchDir;
  for (const part of parts) {
    dir = join(dir, part);
    let info;
    try {
      info = await lstat(dir);
    } catch {
      await mkdir(dir, { mode: 0o700 });
      continue;
    }
    if (!info.isDirectory()) {
      throw new Error(
        `The reproduction script's directory ${relative(scratchDir, dir)} is not a directory in the scratch directory.`,
      );
    }
  }
  try {
    await writeFile(full, content, { mode: 0o700, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export interface VerdictDecision {
  /**
   * `unverified`: the disprover couldn't check the finding. The engine
   * leaves the finding pending, so it is verified again in the next round.
   */
  verdict: "confirmed" | "disproved" | "pre-existing" | "unverified";
  verification: "script" | "code-reading";
  /** `null` when the run has no base, so whether the flaw is new is unknown. */
  introduced: boolean | null;
  evidence: string;
  /**
   * The severity the disprover gives a confirmed finding against the
   * severity anchors, when it differs from the reporter's. Absent otherwise.
   */
  severity?: Finding["severity"];
}

function describeRun(where: string, run: ScriptRun): string {
  const how = run.notStarted
    ? "didn't start"
    : run.timedOut
      ? "timed out"
      : run.signal
        ? `was killed by ${run.signal}`
        : `exit ${run.exitCode}`;
  return `Engine rerun at ${where}: ${how}.${run.output ? ` ${run.output}` : ""}`;
}

/**
 * Text in a failed tool call's error that says the tool couldn't run at
 * all, as opposed to a command that ran and failed: a sandbox that can't
 * start, a refused permission, or a missing program. Only tool errors are
 * matched against it; evidence names error codes such as `EACCES` when it
 * describes the reviewed code.
 */
const TOOL_FAILURE =
  /\bbwrap\b|bubblewrap|landlock|seccomp|sandbox(?:ing)? (?:error|failure|failed|denied|refused|unavailable|execution failed)|(?:sandbox|namespace)[^.\n]{0,40}(?:fail|denied|refused|not permitted|no permission)|no permissions? to create (?:a )?new namespace|operation not permitted|permission denied|read-only file system|\bEACCES\b|\bEPERM\b|command not found|could not (?:run|execute|start)|couldn't (?:run|execute|start)|unable to (?:run|execute|start)|failed to (?:run|execute|start|spawn)|tool (?:call )?(?:failed|error)/i;

/**
 * Evidence that admits the disprover didn't check the finding: it says so,
 * or says its sandbox or its own tools failed. "Could not reproduce" isn't
 * here: a disprover that tried and saw no failure says exactly that.
 */
const UNCHECKED =
  /\bunverified\b|not (?:been )?verified|could(?:n't| not) (?:verify|confirm|check|test)|unable to (?:verify|confirm|check|test)|not demonstrated|cannot (?:verify|confirm|check)|\bbwrap\b|bubblewrap|sandbox(?:ing)? (?:error|failure|failed|denied|refused|unavailable|execution failed)|(?:sandbox|namespace)[^.\n]{0,40}(?:fail|denied|refused|not permitted|no permission)|no permissions? to create (?:a )?new namespace|tool (?:call )?(?:failed|error)|\b(?:I|we) (?:could(?:n't| not)|was unable to|were unable to|failed to) (?:run|execute|start|spawn)\b/i;

/** The shortest evidence that can carry a positive reason to disprove. */
const MIN_DISPROOF_EVIDENCE = 20;

/**
 * Why a `disproved` answer doesn't count, or `null` when it does. A
 * disprover must show that the failure case can't happen; one whose tools
 * failed, or whose evidence admits it didn't check, hasn't.
 */
export function disproofProblem(
  output: VerifyOutput,
  toolErrors: readonly string[],
): string | null {
  const evidence = output.evidence.trim();
  if (evidence.length < MIN_DISPROOF_EVIDENCE) return "The disproof gives no evidence.";
  if (UNCHECKED.test(evidence)) {
    return "The disprover's evidence says it couldn't check the finding.";
  }
  const failed = toolErrors.find((e) => TOOL_FAILURE.test(e));
  if (failed) return `The disprover's tools failed: ${failed.replace(/\s+/g, " ").slice(0, 200)}`;
  return null;
}

/**
 * Combines the disprover's answer with the engine's own script runs. A
 * disprover that couldn't check the finding never disproves it: an
 * `unverified` answer, or a `disproved` one that `disproofProblem()`
 * rejects, makes the finding `unverified`. Only a
 * script that reproduces the flaw at the tip counts as script verification,
 * and only then does the base run count: the flaw is pre-existing when the
 * script reproduces it at the base as well. A script that fails to run at
 * the tip leaves the verdict to the disprover's reading; one that fails to
 * run at the base leaves the finding introduced. A failed run never makes a
 * finding pre-existing.
 */
export function decideVerdict(
  output: VerifyOutput,
  tip: ScriptRun | null,
  base: ScriptRun | null,
  toolErrors: readonly string[] = [],
  /** A whole-project run has no base, so `introduced` is unknown (`null`). */
  noBase = false,
): VerdictDecision {
  const parts = [output.evidence.trim()];
  const newFlaw = noBase ? null : true;
  if (output.verdict === "unverified") {
    return {
      verdict: "unverified",
      verification: output.verification,
      introduced: newFlaw,
      evidence: parts.join("\n"),
    };
  }
  if (output.verdict === "disproved") {
    const problem = disproofProblem(output, toolErrors);
    if (problem) {
      parts.push(
        `${problem} The engine doesn't accept the disproof and leaves the finding pending.`,
      );
      return {
        verdict: "unverified",
        verification: output.verification,
        introduced: newFlaw,
        evidence: parts.join("\n").trim(),
      };
    }
    return {
      verdict: "disproved",
      verification: output.verification,
      introduced: newFlaw,
      evidence: parts.join("\n"),
    };
  }
  let verification: "script" | "code-reading" = output.verification;
  let presentAtBase = !noBase && output.presentAtBase;
  if (tip) {
    parts.push(describeRun("tip", tip));
    const atTip = classifyRun(tip);
    if (atTip === "reproduced") {
      verification = "script";
      const atBase = base ? classifyRun(base) : "failed";
      if (base) parts.push(describeRun("base", base));
      if (noBase) {
        presentAtBase = false;
      } else if (atBase === "failed") {
        presentAtBase = false;
        parts.push(
          "The script didn't run at the base, so the engine treats the flaw as introduced.",
        );
      } else {
        presentAtBase = atBase === "reproduced";
      }
    } else {
      verification = "code-reading";
      parts.push(
        atTip === "clean"
          ? "The script didn't reproduce the flaw when the engine reran it, so the verdict rests on code reading."
          : "The script failed to run, so the verdict rests on the disprover's code reading.",
      );
    }
  }
  if (presentAtBase) {
    return { verdict: "pre-existing", verification, introduced: false, evidence: parts.join("\n") };
  }
  return {
    verdict: "confirmed",
    verification,
    introduced: newFlaw,
    evidence: parts.join("\n"),
    ...(output.severity ? { severity: output.severity } : {}),
  };
}

export interface VerifyDeps {
  /** Uses the compact prompt of the `standard` depth. */
  standard?: boolean;
  /** Findings at the same or nearby lines, which the prompt lists for consistent verdicts. */
  related?: readonly Finding[];
  runner: CommandRunner;
  range: RangeInfo;
  policy: PolicyFile;
  /** The base checkout, or `null` when the run has no base to compare. */
  baseWorktree: BaseWorktree | null;
  scratchDirFor: (findingId: string) => string;
  timeoutMs: number;
  /**
   * Runs `fn` in a throwaway checkout that the engine owns, of the tip the
   * disprover read or of the base, and removes the checkout afterwards. A
   * reproduction script runs only there, never in the checkout under review
   * or in the checkouts parallel disprovers read.
   */
  inScriptCheckout: <T>(side: "tip" | "base", fn: (dir: string) => Promise<T>) => Promise<T>;
  /** The run's cancel signal; it stops a reproduction script. */
  signal?: AbortSignal;
  /**
   * Makes the disprover call under a lease. Throws when the call failed
   * after its retry (`AgentFailed`) or the server refused the role a lease
   * (`RoleDenied`), which fails the verify stage and the run, as any failed
   * agent call does. `null` means no disprover answered and the finding
   * stays pending.
   */
  callDisprover: (
    vendor: Vendor,
    finding: Finding,
    request: AdapterRequest,
  ) => Promise<{
    vendor: Vendor;
    model: string;
    output: VerifyOutput;
    /** Tool calls that failed during the call, from the vendor's event stream. */
    toolErrors?: string[];
  } | null>;
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
  const baseDir = deps.baseWorktree ? await deps.baseWorktree.ensure() : null;
  const prompt = disproverPrompt({
    ...(deps.standard ? { standard: true } : {}),
    range: deps.range,
    finding,
    scratchDir,
    baseWorktree: baseDir,
    policySection: policyPromptSection(deps.policy, finding.file ? [finding.file] : undefined),
    ...(deps.related ? { related: deps.related } : {}),
  });
  const answer = await deps.callDisprover(vendor, finding, {
    prompt,
    repoPath: deps.range.repoPath,
    ...(baseDir ? { extraDirs: [baseDir] } : {}),
    scratchDir,
    toolPolicy: "read-only",
    timeoutMs: deps.timeoutMs,
  });
  if (!answer) return null;
  return judgeAnswer(finding, answer, scratchDir, deps);
}

/**
 * Turns a disprover's answer for one finding into a result: reruns the
 * reproduction script the answer names, and combines the two.
 */
export async function judgeAnswer(
  finding: Finding,
  answer: {
    vendor: Vendor;
    model: string;
    output: VerifyOutput;
    toolErrors?: string[];
  },
  scratchDir: string,
  deps: Pick<VerifyDeps, "runner" | "signal" | "inScriptCheckout"> & {
    baseWorktree?: BaseWorktree | null;
  },
): Promise<VerifyResult> {
  let tipRun: ScriptRun | null = null;
  let baseRun: ScriptRun | null = null;
  if (answer.output.script && answer.output.verdict === "confirmed") {
    const script = answer.output.script;
    const run = async (side: "tip" | "base"): Promise<ScriptRun> => {
      try {
        return await deps.inScriptCheckout(side, (dir) =>
          runReproScript(deps.runner, scratchDir, script, dir, undefined, deps.signal),
        );
      } catch (error) {
        return failedRun(`The engine couldn't run the script: ${(error as Error).message}`);
      } finally {
        throwIfAborted(deps.signal);
      }
    };
    tipRun = await run("tip");
    // The base comparison counts only after the script reproduced at the tip.
    if (deps.baseWorktree !== null && classifyRun(tipRun) === "reproduced") {
      baseRun = await run("base");
    }
  }
  return {
    findingId: finding.id,
    vendor: answer.vendor,
    model: answer.model,
    decision: decideVerdict(
      answer.output,
      tipRun,
      baseRun,
      answer.toolErrors ?? [],
      deps.baseWorktree === null,
    ),
    tipRun,
    baseRun,
  };
}
