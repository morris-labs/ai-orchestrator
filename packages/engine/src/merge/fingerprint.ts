// Finding fingerprints: SHA-1 of the file, the enclosing symbol, and the
// normalized title (design.md, "Finding schema").
import { createHash } from "node:crypto";

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "in",
  "on",
  "of",
  "to",
  "for",
  "when",
  "is",
  "are",
  "be",
  "with",
  "and",
  "or",
  "can",
  "may",
  "might",
  "could",
  "its",
  "it",
  "this",
  "that",
  "from",
  "by",
  "at",
  "as",
  "not",
  "no",
]);

/** Lowercase words of the title, without punctuation, digits, or stopwords. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/`[^`]*`/g, (m) => m.slice(1, -1))
    .replace(/[^a-z_\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export function normalizeTitle(title: string): string {
  return titleTokens(title).join(" ");
}

/** Jaccard similarity of two titles' token sets, from 0 to 1. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / (ta.size + tb.size - common);
}

/**
 * Jaccard similarity of two texts' word sets, such as two failure cases,
 * from 0 to 1. Unlike `titleSimilarity`, a text with no words matches
 * nothing, so two empty failure cases don't count as alike.
 */
export function textSimilarity(a: string, b: string): number {
  if (titleTokens(a).length === 0 || titleTokens(b).length === 0) return 0;
  return titleSimilarity(a, b);
}

const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, // Python function
  /^\s*class\s+([A-Za-z_$][\w$]*)/, // class in most languages
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, // Go
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/, // Rust
  /^\s*(?:public|private|protected|static|async|override|readonly|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, // method
];

const NOT_SYMBOLS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "else",
]);

/**
 * The name of the function or class that encloses `line` (1-based) in
 * `content`, found by scanning upward for a declaration; empty when none.
 */
export function enclosingSymbol(content: string | null, line: number): string {
  if (!content) return "";
  const lines = content.split("\n");
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const text = lines[i] as string;
    for (const re of SYMBOL_PATTERNS) {
      const m = re.exec(text);
      if (m?.[1] && !NOT_SYMBOLS.has(m[1])) return m[1];
    }
  }
  return "";
}

export function fingerprint(file: string | null, symbol: string, title: string): string {
  return createHash("sha1")
    .update(`${file ?? ""}\n${symbol}\n${normalizeTitle(title)}`)
    .digest("hex");
}
