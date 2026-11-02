// Reads changed code as plain text for the tier signals: changed symbols,
// exported declarations, risky constructs, and whether code changed at all.
// A language this file doesn't know skips the symbol signals.
import { posix } from "node:path";

export type Language = "js" | "python" | "go" | "java" | "c" | "shell";

const EXTENSIONS: Record<string, Language> = {
  ".ts": "js",
  ".tsx": "js",
  ".mts": "js",
  ".cts": "js",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "c",
  ".cpp": "c",
  ".cxx": "c",
  ".hh": "c",
  ".hpp": "c",
  ".sh": "shell",
  ".bash": "shell",
};

export function languageOf(path: string): Language | null {
  return EXTENSIONS[posix.extname(path).toLowerCase()] ?? null;
}

const SYMBOL_PATTERNS: Record<Language, readonly RegExp[]> = {
  js: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^={]+)?\{\s*$/,
  ],
  python: [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)/],
  java: [
    /^\s*(?:(?:public|protected|private|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+(\w+)/,
    /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized)\s+)+[\w<>[\], ?]+\s+(\w+)\s*\(/,
  ],
  c: [
    /^\s*(?:class|struct|enum|union)\s+(\w+)/,
    /^\s*#\s*define\s+(\w+)/,
    /^[A-Za-z_][\w:*&<>,\s~]*?\b(?:\w+::)*~?(\w+)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/,
  ],
  shell: [/^\s*function\s+([A-Za-z_]\w*)/, /^\s*([A-Za-z_]\w*)\s*\(\)/],
};

/** Words too common for a reference count to mean anything. */
export const SYMBOL_STOPLIST: ReadonlySet<string> = new Set(
  "main init test tests setup teardown start stop close open read write name type data value values item items list next self this else elif then while for return switch case catch function class public private static const void null true false print render handle handler index error result config options args string number object default".split(
    " ",
  ),
);

const SAFE_SYMBOL = /^[A-Za-z_$][\w$]*$/;
/** The most symbols counted per file. */
export const MAX_SYMBOLS_PER_FILE = 20;

function definedOn(language: Language, line: string): string | null {
  for (const re of SYMBOL_PATTERNS[language]) {
    const name = re.exec(line)?.[1];
    if (name) return name;
  }
  return null;
}

const COMMENT_LEAD = /^\s*(?:$|\/\/|\/\*|\*|#(?!\s*(?:include|define|if|ifdef|ifndef|else|endif)))/;

/** Lines of one file's `git diff -W` hunks, each with its diff prefix. */
export type FunctionDiffLines = readonly string[];

/**
 * The symbols a file's change touches: for each changed line that isn't
 * blank or a comment, the nearest definition at or before it in its hunk.
 */
export function changedSymbols(language: Language, diff: FunctionDiffLines): string[] {
  const out = new Set<string>();
  let current: string | null = null;
  for (const raw of diff) {
    if (raw.startsWith("@@")) {
      current = null;
      continue;
    }
    const mark = raw[0];
    if (mark !== " " && mark !== "+" && mark !== "-") continue;
    const line = raw.slice(1);
    current = definedOn(language, line) ?? current;
    if (mark !== " " && current && !COMMENT_LEAD.test(line)) out.add(current);
  }
  return [...out]
    .filter((s) => SAFE_SYMBOL.test(s) && s.length >= 4 && !SYMBOL_STOPLIST.has(s))
    .sort()
    .slice(0, MAX_SYMBOLS_PER_FILE);
}

/** The changed lines of a `git diff -W` hunk list, without their prefixes or comments. */
export function changedCode(diff: FunctionDiffLines): string[] {
  let inHunk = false;
  const out: string[] = [];
  for (const raw of diff) {
    if (raw.startsWith("@@")) inHunk = true;
    else if (inHunk && (raw[0] === "+" || raw[0] === "-")) {
      const line = raw.slice(1);
      if (!COMMENT_LEAD.test(line)) out.push(line);
    }
  }
  return out;
}

const HEADER = /\.(h|hh|hpp)$/i;

/** True when a changed line declares something other code can import. */
export function changesExport(path: string, language: Language | null, code: readonly string[]) {
  const re: RegExp | null =
    language === "js"
      ? /^\s*export\b/
      : language === "go"
        ? /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)[A-Z]/
        : language === "java"
          ? /^\s*public\b/
          : language === "python"
            ? /^(?:async\s+)?(?:def|class)\s+[A-Za-z]/
            : language === "c" && HEADER.test(path)
              ? /^\s*(?:(?:class|struct|enum|union)\s+\w+|[A-Za-z_].*\))/
              : null;
  return re !== null && code.some((line) => re.test(line));
}

const SCHEMA_PATH =
  /(^|\/)schemas?\/|(^|\/)[^/]*schema[^/]*$|\.(proto|graphql|gql|avsc|xsd)$|(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i;

export function isSchemaPath(path: string): boolean {
  return SCHEMA_PATH.test(path);
}

const RISKY: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "concurrency",
    /\b(?:Mutex|RWMutex|Semaphore|WaitGroup|Atomics|AtomicInteger|synchronized|pthread_\w+|std::thread|std::mutex|lock_guard|threading|asyncio\.gather|ExecutorService|flock)\b|\bgo\s+func\b|\bchan\s+\w|\bPromise\.(?:all|race|allSettled|any)\b|\bnew\s+Worker\b/,
  ],
  ["migrations", /\b(?:ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|migrations?)\b/i],
  [
    "parsing",
    /\b(?:\w*[Pp]arser\w*|[Tt]okeni[sz]e\w*|[Ll]exer|[Dd]eseriali[sz]e\w*|[Uu]nmarshal\w*|JSON\.parse|yaml\.(?:safe_)?load|ast\.parse|parse[A-Z_]\w*)\b/,
  ],
];

/** The kind of risky change in these lines of `path`, or `null`. */
export function riskyChange(path: string, code: readonly string[]): string | null {
  if (/(^|\/)migrations?\//i.test(path)) return "migrations";
  for (const [name, re] of RISKY) if (code.some((line) => re.test(line))) return name;
  return null;
}

const LOCKFILES: ReadonlySet<string> = new Set(
  "pnpm-lock.yaml package-lock.json npm-shrinkwrap.json yarn.lock bun.lock Cargo.lock poetry.lock Pipfile.lock uv.lock pdm.lock go.sum composer.lock Gemfile.lock flake.lock".split(
    " ",
  ),
);
const DOC_NAMES = /^(?:README|LICENSE|LICENCE|NOTICE|AUTHORS|CHANGELOG|CONTRIBUTING)$/i;
const NOT_DOC_TXT = /^(?:CMakeLists|requirements[\w.-]*|constraints[\w.-]*)\.txt$/i;

/** True for a documentation file or lockfile. Anything else counts as code, whatever its folder. */
export function isDocOrLockfile(path: string): boolean {
  const name = posix.basename(path);
  if (LOCKFILES.has(name)) return true;
  if (NOT_DOC_TXT.test(name)) return false;
  return /\.(md|mdx|rst|adoc|txt)$/i.test(name) || DOC_NAMES.test(name);
}

/** `text` without comments, line for line. Understands strings well enough to skip markers in them. */
export function stripComments(language: Language, text: string): string {
  if (language === "shell") return text.replace(/^[ \t]*#(?!!).*$/gm, "");
  const hash = language === "python";
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (text.startsWith(quote, i)) {
        out += quote;
        i += quote.length;
        quote = null;
      } else {
        if (ch === "\n" && quote.length === 1 && quote !== "`") quote = null;
        out += ch;
        i += 1;
      }
    } else if (hash && ch === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (!hash && text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (!hash && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
    } else if (hash && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      quote = text.slice(i, i + 3);
      out += quote;
      i += 3;
    } else if (ch === '"' || ch === "'" || (ch === "`" && language !== "python")) {
      quote = ch;
      out += ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

const TOKEN = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`|\w+|\S/g;

/**
 * True when two versions of a file differ only in comments or formatting.
 * In Python and shell, where whitespace carries meaning, only blank lines and
 * trailing space count as formatting. An unknown language never qualifies.
 */
export function sameCode(language: Language | null, base: string, tip: string): boolean {
  if (language === null) return false;
  const a = stripComments(language, base);
  const b = stripComments(language, tip);
  if (language === "python" || language === "shell") {
    const lines = (t: string) =>
      t
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l !== "")
        .join("\n");
    return lines(a) === lines(b);
  }
  return (a.match(TOKEN) ?? []).join("\0") === (b.match(TOKEN) ?? []).join("\0");
}
