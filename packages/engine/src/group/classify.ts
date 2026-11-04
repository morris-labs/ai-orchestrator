// Path and import heuristics for grouping changed files.
import { posix } from "node:path";

export type FileKind = "source" | "test" | "doc";

const TEST_PATTERNS = [
  /(^|\/)(tests?|__tests__|specs?)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.(go|py|rb)$/,
  /(^|\/)test_[^/]*\.py$/,
  /Tests?\.(java|kt|cs)$/,
];

const DOC_PATTERNS = [/\.(md|mdx|rst|adoc|txt)$/i, /(^|\/)docs?\//];

export function fileKind(path: string): FileKind {
  if (TEST_PATTERNS.some((re) => re.test(path))) return "test";
  if (DOC_PATTERNS.some((re) => re.test(path))) return "doc";
  return "source";
}

/** The file name without directory, extension, and test markers: `test_orders.py` gives `orders`. */
export function stem(path: string): string {
  let name = posix.basename(path);
  name = name.replace(/\.(test|spec)(?=\.[^.]+$)/, "");
  name = name.replace(/\.[^.]+$/, "");
  name = name
    .replace(/^test_/, "")
    .replace(/_test$/, "")
    .replace(/Tests?$/, "");
  return name.toLowerCase();
}

function withoutExtension(path: string): string {
  return path
    .replace(/\.[cm]?[jt]sx?$|\.py$/, "")
    .replace(/\/index$/, "")
    .replace(/\/__init__$/, "");
}

/**
 * The repository paths, without extension, that `content` (the file at
 * `path`) imports, by plain-text reading of JS/TS and Python import lines.
 */
export function importedModules(path: string, content: string): string[] {
  const dir = posix.dirname(path);
  const out = new Set<string>();
  const jsRe = /(?:from\s+|import\s+|require\(\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const m of content.matchAll(jsRe)) {
    out.add(withoutExtension(posix.normalize(posix.join(dir, m[1] as string))));
  }
  const pyFrom = /^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w, ]+)/gm;
  for (const m of content.matchAll(pyFrom)) {
    const dots = (m[1] as string).length;
    const mod = (m[2] as string).replace(/\./g, "/");
    const names = (m[3] as string)
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    let baseDir = "";
    if (dots > 0) {
      baseDir = dir;
      for (let i = 1; i < dots; i++) baseDir = posix.dirname(baseDir);
    }
    const modPath = posix.join(baseDir, mod);
    if (mod) out.add(`py:${modPath}`);
    for (const n of names) out.add(`py:${posix.join(modPath, n)}`);
  }
  const pyImport = /^\s*import\s+([\w.]+)/gm;
  for (const m of content.matchAll(pyImport)) out.add(`py:${(m[1] as string).replace(/\./g, "/")}`);
  return [...out];
}

/** True when an entry from `importedModules` refers to `target`. */
export function importsFile(imports: readonly string[], target: string): boolean {
  const bare = withoutExtension(target);
  for (const imp of imports) {
    if (imp.startsWith("py:")) {
      const mod = imp.slice(3);
      if (mod === "") continue;
      if (bare === mod || bare.endsWith(`/${mod}`)) return true;
    } else if (imp === bare) return true;
  }
  return false;
}

/**
 * Answers `importsFile` for many targets at once: gives the targets an import
 * list refers to, without testing each import against each target.
 */
export class ImportIndex {
  private readonly exact = new Map<string, string[]>();
  private readonly python = new Map<string, string[]>();

  constructor(targets: readonly string[]) {
    const add = (map: Map<string, string[]>, key: string, target: string) => {
      const list = map.get(key);
      if (list) list.push(target);
      else map.set(key, [target]);
    };
    for (const target of targets) {
      const bare = withoutExtension(target);
      add(this.exact, bare, target);
      const parts = bare.split("/");
      for (let i = 0; i < parts.length; i++) add(this.python, parts.slice(i).join("/"), target);
    }
  }

  /** The targets that `imports`, from `importedModules`, refer to. */
  targetsOf(imports: readonly string[]): string[] {
    const out = new Set<string>();
    for (const imp of imports) {
      const found = imp.startsWith("py:")
        ? imp === "py:"
          ? undefined
          : this.python.get(imp.slice(3))
        : this.exact.get(imp);
      for (const target of found ?? []) out.add(target);
    }
    return [...out];
  }
}
