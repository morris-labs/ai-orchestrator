// Reads changed code as plain text for the tier signals: changed symbols,
// exported declarations, and risky constructs. These signals only raise a
// tier. Whether a file can take the small tier depends on its path alone
// (`isDocOrLockfile`), so a wrong guess here can't lower a change's review.
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
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+|const\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    // Only a top-level or exported variable: an indented one is local to its function.
    /^(?:\s*export\s+(?:declare\s+)?)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^={]+)?\{\s*$/,
    /^\s*(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  ],
  python: [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/, /^([A-Z_][A-Z0-9_]*)\s*=/],
  go: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)/, /^(?:var|const)\s+(\w+)/],
  java: [
    /^\s*(?:(?:public|protected|private|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+(\w+)/,
    /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized)\s+)+[\w<>[\], ?]+\s+(\w+)\s*\(/,
    // A constructor, and a method with no modifier.
    /^\s*(?:(?:public|protected|private)\s+)?([A-Z]\w*)\s*\([^;]*\)\s*(?:throws\s[^{]*)?\{\s*$/,
    /^\s+[\w<>[\],?]+\s+(\w+)\s*\([^;]*\)\s*(?:throws\s[^{]*)?\{\s*$/,
  ],
  c: [
    // A type's own definition, not a variable of that type such as `struct point p;`.
    /^\s*(?:enum\s+(?:class|struct)|class|struct|enum|union)\s+(?:[A-Z_][A-Z0-9_]*\s+)?(\w+)\s*(?:final\s*)?(?::[^;]*)?\{?\s*$/,
    /^\s*#\s*define\s+(\w+)/,
    /^[A-Za-z_][\w:*&<>,\s~]*?\b(?:\w+::)*~?(\w+)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/,
  ],
  shell: [/^\s*function\s+([A-Za-z_]\w*)/, /^\s*([A-Za-z_]\w*)\s*\(\)/],
};

/** Words a pattern can capture that never name a definition. */
const NOT_A_NAME: ReadonlySet<string> = new Set(
  "if for while switch catch return function class extends implements struct enum union else do try new await yield typeof sizeof".split(
    " ",
  ),
);

/** Lowercase words too common for a reference count to mean anything. */
export const SYMBOL_STOPLIST: ReadonlySet<string> = new Set(
  "main init test tests setup teardown start stop close open read write name type data value values item items list next self this else elif then while for return switch case catch function class public private static const void null true false print render handle handler index error result config options args string number object default constructor destructor __init__ __str__ __repr__ tostring equals hashcode unknown".split(
    " ",
  ),
);

const SAFE_SYMBOL = /^[A-Za-z_$][\w$]*$/;

function definedOn(language: Language, line: string): string | null {
  for (const re of SYMBOL_PATTERNS[language]) {
    const name = re.exec(line)?.[1];
    if (name && !NOT_A_NAME.has(name)) return name;
  }
  return null;
}

/** Lines of one file's `git diff -W` hunks, each with its diff prefix. */
export type FunctionDiffLines = readonly string[];

/**
 * The symbols a file's change touches: for each changed line that isn't
 * blank, the nearest definition at or before it in its hunk. The names are
 * sorted. The reference budget, not a count, limits how many get counted.
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
    if (mark !== " " && current && line.trim() !== "") out.add(current);
  }
  return [...out]
    .filter((s) => SAFE_SYMBOL.test(s) && s.length >= 4 && !SYMBOL_STOPLIST.has(s.toLowerCase()))
    .sort();
}

/** The changed lines of a `git diff -W` hunk list that aren't blank, without their prefixes. */
export function changedCode(diff: FunctionDiffLines): string[] {
  let inHunk = false;
  const out: string[] = [];
  for (const raw of diff) {
    if (raw.startsWith("@@")) inHunk = true;
    else if (inHunk && (raw[0] === "+" || raw[0] === "-")) {
      const line = raw.slice(1);
      if (line.trim() !== "") out.push(line);
    }
  }
  return out;
}

const HEADER = /\.(h|hh|hpp)$/i;

const EXPORT_PATTERNS: Partial<Record<Language, RegExp>> = {
  js: /^\s*export\b|^\s*module\.exports\b|^\s*exports\.\w+\s*=/,
  // A top-level declaration, or a member of a `const (`, `var (`, or `type (` block.
  go: /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+|var\s+|const\s+)[A-Z]|^\t[A-Z]\w*(?:\s+[\w.*[]|\s*=)/,
  java: /^\s*public\b/,
  python: /^\s*(?:async\s+)?(?:def|class)\s+[A-Za-z]|^__all__\b|^[A-Z][A-Z0-9_]*\s*=/,
};
const C_HEADER_EXPORT =
  /^(?:(?:class|struct|enum|union|typedef|extern)\b|#\s*define\b|(?!return\b)[A-Za-z_][\w\s*&:<>,~]*\([^;{]*\)\s*(?:const\s*)?;?\s*$)/;

/** True when a changed line declares something other code can import. */
export function changesExport(path: string, language: Language | null, code: readonly string[]) {
  const re =
    language === null
      ? undefined
      : language === "c"
        ? HEADER.test(path)
          ? C_HEADER_EXPORT
          : undefined
        : EXPORT_PATTERNS[language];
  return re !== undefined && code.some((line) => re.test(line));
}

const SCHEMA_PATH =
  /(^|\/)schemas?\/|(^|\/)(?:[^/]*[._-])?schemas?\.[^/]+$|\.(proto|graphql|gql|avsc|xsd|sql|prisma|thrift|fbs)$|(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i;

export function isSchemaPath(path: string): boolean {
  return SCHEMA_PATH.test(path);
}

const RISKY: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "concurrency",
    /\b(?:Mutex|RWMutex|Semaphore|WaitGroup|Atomics|AtomicInteger|ReentrantLock|ThreadPoolExecutor|synchronized|pthread_\w+|std::thread|std::mutex|std::atomic|std::async|lock_guard|threading|asyncio\.gather|asyncio\.create_task|ExecutorService|flock|sync\.Once)\b|\bgo\s+(?:func\b|[\w.]+\()|\bchan\s+\w|\bselect\s*\{|\bPromise\.(?:all|race|allSettled|any)\b|\bnew\s+(?:Worker|Thread)\b/,
  ],
  ["migrations", /\b(?:ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|migrations?)\b/i],
  [
    "parsing",
    /\b(?:\w*[Pp]arser\w*|[Tt]okeni[sz]e\w*|[Ll]exer|[Dd]eseriali[sz]e\w*|[Uu]nmarshal\w*|JSON\.parse|json\.loads|pickle\.loads|yaml\.(?:safe_)?load|ast\.parse|parse(?!Int\b|Float\b)[A-Z_]\w*)\b/,
  ],
];

const MIGRATION_PATH = /(^|\/)(?:migrations?\/|db\/migrate\/|alembic\/versions\/)/i;

/** The kind of risky change in these lines of `path`, or `null`. */
export function riskyChange(path: string, code: readonly string[]): string | null {
  if (MIGRATION_PATH.test(path)) return "migrations";
  for (const [name, re] of RISKY) if (code.some((line) => re.test(line))) return name;
  return null;
}

const LOCKFILES: ReadonlySet<string> = new Set(
  "pnpm-lock.yaml package-lock.json npm-shrinkwrap.json yarn.lock bun.lock Cargo.lock poetry.lock Pipfile.lock uv.lock pdm.lock go.sum composer.lock Gemfile.lock flake.lock".split(
    " ",
  ),
);
const DOC_NAMES = /^(?:README|LICENSE|LICENCE|NOTICE|AUTHORS|CHANGELOG|CONTRIBUTING)(?:\.txt)?$/i;
/** Markdown that tells an agent what to do changes behavior, so it counts as code. */
const AGENT_NAMES =
  /^(?:CLAUDE|AGENTS|GEMINI|SKILL|copilot-instructions)(?:\.[\w-]+)?\.md$|\.(?:prompt|instructions|agent)\.md$/i;
const AGENT_FOLDERS = /(^|\/)(?:\.claude|\.codex|\.copilot|\.cursor|\.github|prompts?|skills?)\//i;

function isDocPath(path: string): boolean {
  const name = posix.basename(path);
  if (AGENT_NAMES.test(name) || AGENT_FOLDERS.test(path)) return false;
  return /\.(md|rst|adoc)$/i.test(name) || DOC_NAMES.test(name);
}

/**
 * True for a documentation file or lockfile, by path alone. These are the only
 * files that can take the small tier. Anything else counts as code, including
 * MDX, plain text files, and Markdown that instructs an agent.
 */
export function isDocOrLockfile(path: string): boolean {
  return LOCKFILES.has(posix.basename(path)) || isDocPath(path);
}
