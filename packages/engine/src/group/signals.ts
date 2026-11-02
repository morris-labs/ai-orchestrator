// Measures each changed file for the tier choice with git, and gives each
// group its tier. Never calls a model, and a git failure only drops a signal.
import type { FileGroup, ModelTierChoice, PolicyFile } from "@aio/contracts";
import { matchesAny } from "../policy/glob.js";
import { isRiskPath } from "../policy/rules.js";
import { parseDiff, type DiffFile } from "../range/diff.js";
import type { Git } from "../range/git.js";
import { fileKind, stem } from "./classify.js";
import {
  changedCode,
  changedSymbols,
  changesExport,
  isDocOrLockfile,
  isSchemaPath,
  languageOf,
  riskyChange,
  sameCode,
} from "./symbols.js";
import { groupTier, type FileSignals } from "./tier.js";

/** How long the reference counts of one round may take in total. */
export const REFERENCE_BUDGET_MS = 15_000;

export interface TierInputs {
  git: Git;
  policy: PolicyFile;
  diffBase: string;
  tip: string;
  choice: ModelTierChoice;
  now?: () => number;
  budgetMs?: number;
}

/** Splits `git diff -W` output by file path, with each file's lines from its first hunk on. */
export function splitFunctionDiff(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const chunk of text.split(/^(?=diff --git )/m)) {
    const path = parseDiff(chunk)[0]?.path;
    if (!path) continue;
    const lines = chunk.split("\n");
    const first = lines.findIndex((l) => l.startsWith("@@"));
    out.set(path, first < 0 ? [] : lines.slice(first));
  }
  return out;
}

/** True when `other` doesn't count as a reference to code in `path`. */
function excluded(path: string, other: string): boolean {
  if (other === path) return true;
  const kind = fileKind(other);
  // The docs mention a symbol without calling it.
  if (kind === "doc") return true;
  return kind === "test" && stem(other) === stem(path);
}

function pinnedTier(policy: PolicyFile, path: string) {
  return policy.tierPaths?.find((rule) => matchesAny(path, rule.paths))?.tier ?? null;
}

/** Gives every group its tier and reason. */
export async function assignTiers(
  groups: readonly FileGroup[],
  files: readonly DiffFile[],
  inputs: TierInputs,
): Promise<FileGroup[]> {
  const { git, policy, diffBase, tip, choice } = inputs;
  if (choice !== "auto") return groups.map((g) => ({ ...g, ...tierFields(g, [], choice) }));
  const now = inputs.now ?? Date.now;
  const deadline = now() + (inputs.budgetMs ?? REFERENCE_BUDGET_MS);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const context = await git.functionDiff(diffBase, tip).catch(() => "");
  const diffs = splitFunctionDiff(context);
  const counts = new Map<string, readonly string[] | null>();
  const grep = async (symbol: string): Promise<readonly string[] | null> => {
    if (counts.has(symbol)) return counts.get(symbol) ?? null;
    const left = deadline - now();
    const found = left > 0 ? await git.grepFiles(symbol, tip, left) : null;
    counts.set(symbol, found);
    return found;
  };
  const measured = new Map<string, FileSignals>();
  const measure = async (path: string): Promise<FileSignals> => {
    const known = measured.get(path);
    if (known) return known;
    const file = byPath.get(path);
    const language = languageOf(path);
    const tipText = file?.status === "deleted" ? null : await git.show(tip, path);
    const baseText =
      file?.status === "added" ? null : await git.show(diffBase, file?.oldPath ?? path);
    const noCode =
      isDocOrLockfile(path) ||
      (tipText !== null && baseText !== null && sameCode(language, baseText, tipText));
    const lines = diffs.get(path) ?? [];
    const code = fileKind(path) === "test" ? [] : changedCode(lines);
    let references: FileSignals["references"] = null;
    let referencesSkipped = false;
    if (!noCode && language && fileKind(path) !== "test") {
      for (const symbol of changedSymbols(language, lines)) {
        const found = await grep(symbol);
        if (found === null) {
          referencesSkipped = true;
          continue;
        }
        const others = found.filter((other) => !excluded(path, other)).length;
        if (!references || others > references.files) references = { symbol, files: others };
      }
    }
    const signals: FileSignals = {
      path,
      noCode,
      fileLines: tipText === null ? 0 : tipText.split("\n").length - 1,
      changedLines: (file?.added ?? 0) + (file?.removed ?? 0),
      references,
      referencesSkipped,
      exportedChange: changesExport(path, language, code),
      schemaPath: isSchemaPath(path),
      risky: noCode ? null : riskyChange(path, code),
      riskPath: isRiskPath(policy, path),
      pinned: pinnedTier(policy, path),
    };
    measured.set(path, signals);
    return signals;
  };
  const out: FileGroup[] = [];
  for (const group of groups) {
    const signals: FileSignals[] = [];
    for (const path of group.files) signals.push(await measure(path));
    out.push({ ...group, ...tierFields(group, signals, choice) });
  }
  return out;
}

function tierFields(_group: FileGroup, signals: FileSignals[], choice: ModelTierChoice) {
  const { tier, reason } = groupTier(signals, choice);
  return { tier, tierReason: reason };
}
