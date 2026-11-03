// Measures each changed file for the tier choice with git, and gives each
// group its tier. Never calls a model, and a git failure only drops a signal.
import type { FileGroup, ModelTierChoice, PolicyFile, RunDepth } from "@aio/contracts";
import { matchesAny } from "../policy/glob.js";
import { isRiskPath } from "../policy/rules.js";
import { parseDiff, type DiffFile } from "../range/diff.js";
import type { Git, GrepResult } from "../range/git.js";
import { fileKind, stem } from "./classify.js";
import {
  changedCode,
  changedSymbols,
  changesExport,
  isDocOrLockfile,
  isLockfile,
  lockfileSourceChanged,
  isSchemaPath,
  languageOf,
  riskyChange,
} from "./symbols.js";
import { groupTier, type FileSignals } from "./tier.js";

/** How long the reference counts of one round may take in total. */
export const REFERENCE_BUDGET_MS = 15_000;
/** How long the function diff of one round may take. */
export const FUNCTION_DIFF_BUDGET_MS = 30_000;

export interface TierInputs {
  git: Git;
  policy: PolicyFile;
  diffBase: string;
  tip: string;
  choice: ModelTierChoice;
  /** `standard` reads no history, since only risk paths and policy rules raise a tier. */
  depth?: RunDepth;
  now?: () => number;
  budgetMs?: number;
}

/** Splits `git diff -W` output by file path, with each file's lines from its first hunk on. */
export function splitFunctionDiff(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // Only `\n` ends a line of git's output. The `m` flag also breaks lines at a
  // carriage return, U+2028, or U+2029, which file content can hold.
  for (const chunk of text.split(/(?<=^|\n)(?=diff --git )/)) {
    const path = parseDiff(chunk)[0]?.path;
    if (!path) continue;
    const lines = chunk.split("\n");
    const first = lines.findIndex((l) => l.startsWith("@@"));
    out.set(path, first < 0 ? [] : lines.slice(first));
  }
  return out;
}

const NOT_A_REFERENCE =
  /(^|\/)(?:dist|build|out|vendor|node_modules|__snapshots__|fixtures?)\/|\.(?:snap|json|min\.js|map|csv)$/i;

/** True when `other` doesn't count as a reference to code in `path`. */
function excluded(path: string, other: string): boolean {
  if (other === path) return true;
  const kind = fileKind(other);
  // The docs mention a symbol without calling it.
  if (kind === "doc") return true;
  // Generated output and data name a symbol without using it as code does.
  if (isDocOrLockfile(other) || NOT_A_REFERENCE.test(other)) return true;
  return kind === "test" && stem(other) === stem(path);
}

function pinnedTier(policy: PolicyFile, path: string) {
  return policy.tierPaths?.find((rule) => matchesAny(path, rule.paths))?.tier ?? null;
}

/** What a renamed file's old path asks for, by the same order as its current path. */
function oldPathTier(
  policy: PolicyFile,
  path: string,
  file: DiffFile | undefined,
  noCode: boolean,
): FileSignals["oldPathTier"] {
  const old = file?.oldPath;
  if (!old || old === path) return null;
  const from = `renamed from ${old}, which`;
  const pinned = pinnedTier(policy, old);
  if (pinned) return { tier: pinned, why: `${from} the policy's tierPaths sets to this tier` };
  if (isRiskPath(policy, old)) return { tier: "large", why: `${from} matches a risk path` };
  if (!noCode && isSchemaPath(old)) return { tier: "large", why: `${from} is a schema` };
  return null;
}

/** Gives every group its tier and reason. */
export async function assignTiers(
  groups: readonly FileGroup[],
  files: readonly DiffFile[],
  inputs: TierInputs,
): Promise<FileGroup[]> {
  const { git, policy, diffBase, tip, choice } = inputs;
  const depth = inputs.depth ?? "thorough";
  const auto = choice === "auto" && depth !== "standard";
  const now = inputs.now ?? Date.now;
  const byPath = new Map(files.map((f) => [f.path, f]));
  // A fixed tier needs only each file's path, so it reads no history.
  let diffFailed = false;
  const context = auto
    ? await git.functionDiff(diffBase, tip, FUNCTION_DIFF_BUDGET_MS).catch(() => {
        diffFailed = true;
        return "";
      })
    : "";
  const diffs = splitFunctionDiff(context);
  // The budget covers the reference counts only, so it starts after the diff.
  const deadline = now() + (inputs.budgetMs ?? REFERENCE_BUDGET_MS);
  const counts = new Map<string, GrepResult>();
  const grep = async (symbol: string): Promise<GrepResult> => {
    const known = counts.get(symbol);
    if (known !== undefined) return known;
    const left = deadline - now();
    const found = left > 0 ? await git.grepFiles(symbol, tip, left) : "timeout";
    counts.set(symbol, found);
    return found;
  };
  let lockDiffs: Promise<Map<string, string[]>> | undefined;
  const measured = new Map<string, FileSignals>();
  const measure = async (path: string): Promise<FileSignals> => {
    const known = measured.get(path);
    if (known) return known;
    const file = byPath.get(path);
    const language = languageOf(path);
    // A rename keeps the old file's role: code renamed to a doc name is still code.
    const noCode = isDocOrLockfile(path) && (!file?.oldPath || isDocOrLockfile(file.oldPath));
    const lines = diffs.get(path) ?? [];
    const code = fileKind(path) === "test" ? [] : changedCode(lines);
    // A lockfile that points a dependency at another source isn't only a version bump.
    let lockSource = false;
    if (noCode && isLockfile(path) && !pinnedTier(policy, path)) {
      lockDiffs ??= git
        .diff(diffBase, tip)
        .then(splitFunctionDiff)
        .catch(() => new Map<string, string[]>());
      lockSource = lockfileSourceChanged((await lockDiffs).get(path)?.join("\n") ?? "");
    }
    let references: FileSignals["references"] = null;
    let referencesSkipped: FileSignals["referencesSkipped"] = auto && diffFailed ? "diff" : null;
    if (auto && !noCode && language && fileKind(path) !== "test") {
      for (const symbol of changedSymbols(language, lines)) {
        const found = await grep(symbol);
        if (typeof found === "string") {
          referencesSkipped = found;
          continue;
        }
        const others = found.filter((other) => !excluded(path, other)).length;
        if (!references || others > references.files) references = { symbol, files: others };
      }
    }
    const signals: FileSignals = {
      path,
      noCode,
      lockSource,
      references,
      referencesSkipped,
      exportedChange: changesExport(path, language, code),
      schemaPath: isSchemaPath(path),
      risky: noCode ? null : riskyChange(path, code),
      riskPath: isRiskPath(policy, path),
      pinned: pinnedTier(policy, path),
      oldPathTier: oldPathTier(policy, path, file, noCode),
    };
    measured.set(path, signals);
    return signals;
  };
  const out: FileGroup[] = [];
  for (const group of groups) {
    const signals: FileSignals[] = [];
    for (const path of group.files) signals.push(await measure(path));
    out.push({ ...group, ...tierFields(group, signals, choice, depth) });
  }
  return out;
}

function tierFields(
  _group: FileGroup,
  signals: FileSignals[],
  choice: ModelTierChoice,
  depth: RunDepth,
) {
  const { tier, reason } = groupTier(signals, choice, depth);
  return { tier, tierReason: reason };
}
