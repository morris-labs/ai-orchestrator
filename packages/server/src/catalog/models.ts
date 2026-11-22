// Model suggestions and account defaults for the box dialog.
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_TIER_MODELS,
  VENDOR_EFFORT_LEVELS,
  type Effort,
  type ModelCache,
  type Vendor,
  type ModelsResultSchema,
} from "@aio/contracts";
import { parse as parseToml } from "smol-toml";
import type { z } from "zod";
import type { DockerClient } from "../docker/types.js";
import type { HostEnv } from "../records/env.js";
import { ApiError } from "../records/errors.js";

export type ModelsResult = z.infer<typeof ModelsResultSchema>;

/** Used until a scan has run (no Docker, or no image yet). */
export const MODEL_BASELINE: readonly string[] = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

/** Defaults when no settings file names a model or an effort. */
export const FALLBACK_MODEL = "claude-opus-5-5";
export const FALLBACK_EFFORT: Effort = "high";

/** A rescan is due when the cache is this old, even for the same image. */
export const MODEL_CACHE_MAX_AGE_DAYS = 30;

/**
 * The shell command that lists the model ids in the image's `claude` program.
 * A match must be followed by a character that cannot continue an id, so a
 * dated id such as `claude-opus-4-20250514` gives no false `claude-opus-4`.
 */
export const MODEL_SCAN_COMMAND =
  'f=$(readlink -f "$(command -v claude)") && ' +
  "grep -aoE 'claude-(opus|sonnet|haiku|fable)-[0-9]+(-[0-9]{1,2})?([^0-9a-z-]|$)' \"$f\" " +
  "| sed -E 's/[^0-9a-z-]+$//' | sort -u";

type ScannedVendor = Exclude<Vendor, "claude">;

const VENDOR_MODELS: Record<ScannedVendor, readonly string[]> = {
  codex: [
    "gpt-6-astra",
    ...Object.values(DEFAULT_TIER_MODELS.codex ?? {}),
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.5",
  ],
  copilot: ["auto", "claude-sonnet-5-5", "claude-opus-5-5", "gpt-5.6-sol", "gpt-5.5"],
};

const GPT_MODEL =
  "gpt-[0-9]+([.][0-9]+)?(-(astra|sol|terra|luna|codex(-max|-mini)?|mini|nano|pro))?";
const CLAUDE_MODEL = "claude-(opus|sonnet|haiku|fable)-[0-9]+(-[0-9]{1,2})?";
const MODEL_PATTERNS: Record<ScannedVendor, string> = {
  codex: "(gpt-[0-9][a-z0-9.-]*|gpt-daybreak-[a-z0-9.-]+|codex-auto-review)",
  copilot: `(${GPT_MODEL}|${CLAUDE_MODEL}|gemini-[0-9]+([.][0-9]+)?-(pro|flash))`,
};

function scanCommand(vendor: Vendor): string {
  if (vendor === "claude") return MODEL_SCAN_COMMAND;
  // npm installs a launcher and a separate package with the actual program.
  const packageRoot =
    vendor === "codex" ? '$(dirname "$(dirname "$launcher")")' : '$(dirname "$launcher")';
  const pattern =
    vendor === "codex"
      ? `"slug"[[:space:]]*:[[:space:]]*"${MODEL_PATTERNS.codex}"`
      : `${MODEL_PATTERNS.copilot}([^0-9a-z.-]|$)`;
  const trim = vendor === "codex" ? `sed -E 's/.*"([^"]+)"$/\\1/'` : "sed -E 's/[^0-9a-z.-]+$//'";
  return (
    `launcher=$(readlink -f "$(command -v ${vendor})") && ` +
    `root=${packageRoot} && ` +
    `{ find "$root/node_modules" -type f -name ${vendor} -exec grep -ahoE '${pattern}' {} + 2>/dev/null; ` +
    `grep -aoE '${pattern}' "$launcher"; ` +
    (vendor === "copilot" ? `copilot --help | grep -oE '${pattern}'; ` : "") +
    `} | ${trim} | sort -u`
  );
}

export interface ParsedModelId {
  family: string;
  major: number;
  minor: number;
}

/** Parses `claude-<family>-<major>[-<minor>][[...]]`, or returns `undefined`. */
export function parseModelId(id: string): ParsedModelId | undefined {
  const bracket = id.indexOf("[");
  const bare = bracket >= 0 ? id.slice(0, bracket) : id;
  const m = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?$/.exec(bare);
  if (!m) return undefined;
  return { family: m[1] as string, major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
}

const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

function familyRank(family: string): number {
  const i = FAMILY_ORDER.indexOf(family);
  return i < 0 ? FAMILY_ORDER.length : i;
}

/**
 * Sorts ids by family, largest first (fable, opus, sonnet, haiku), then
 * newest first, with a plain id before its `[1m]` form. Returns a new array.
 */
export function sortNewestFirst(ids: readonly string[]): string[] {
  const none: ParsedModelId = { family: "", major: 0, minor: 0 };
  return [...ids].sort((a, b) => {
    const pa = parseModelId(a) ?? none;
    const pb = parseModelId(b) ?? none;
    if (pa.family !== pb.family) return familyRank(pa.family) - familyRank(pb.family);
    if (pa.major !== pb.major) return pb.major - pa.major;
    if (pa.minor !== pb.minor) return pb.minor - pa.minor;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** The current model ids (4.5 and later) in the scan output, sorted. */
export function parseScan(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split("\n")) {
    const id = line.trim();
    if (id === "") continue;
    const p = parseModelId(id);
    if (!p || ids.includes(id)) continue;
    if (p.major < 4 || (p.major === 4 && p.minor < 5)) continue;
    ids.push(id);
  }
  return sortNewestFirst(ids);
}

function readAccountFile(file: string): string | undefined {
  try {
    // A legacy per-file link is not account-owned configuration. In
    // particular, never follow old settings links into a host vendor folder.
    const accountDir = fs.realpathSync(path.dirname(file));
    const target = fs.realpathSync(file);
    if (!target.startsWith(`${accountDir}${path.sep}`)) return undefined;
    return fs.readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  const text = readAccountFile(file);
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The account's extra model options, from `~/.claude.json` `additionalModelOptionsCache[].value`. */
export function accountModels(claudeJson?: string): string[] {
  const root = claudeJson === undefined ? undefined : readJsonObject(claudeJson);
  const list = root?.additionalModelOptionsCache;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (item !== null && typeof item === "object") {
      const value = (item as Record<string, unknown>).value;
      if (typeof value === "string" && value !== "") out.push(value);
    }
  }
  return out;
}

/** Defaults from the selected account only. No account means built-in defaults. */
export function settingsDefaults(claudeDir?: string): { model: string; effort: Effort } {
  const obj = claudeDir ? readJsonObject(path.join(claudeDir, "settings.json")) : undefined;
  return {
    model: modelDefault(obj?.model, FALLBACK_MODEL),
    effort: effortDefault("claude", obj?.effortLevel, FALLBACK_EFFORT),
  };
}

function modelDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function effortDefault(vendor: Vendor, value: unknown, fallback: Effort): Effort {
  return VENDOR_EFFORT_LEVELS[vendor].find((level) => level === value) ?? fallback;
}

function vendorDefaults(vendor: ScannedVendor, dir?: string): ModelsResult["defaults"] {
  if (vendor === "copilot") {
    const config = dir ? readJsonObject(path.join(dir, "config.json")) : undefined;
    return {
      model: modelDefault(config?.model, "auto"),
      effort: effortDefault(vendor, config?.reasoning_effort, "medium"),
    };
  }
  const text = dir ? readAccountFile(path.join(dir, "config.toml")) : undefined;
  let config;
  try {
    config = text === undefined ? undefined : parseToml(text);
  } catch {
    // The CLI reports syntax errors when it reads the account config.
  }
  return {
    model: modelDefault(config?.model, "gpt-6.1-sol"),
    effort: effortDefault(vendor, config?.model_reasoning_effort, "medium"),
  };
}

export interface ModelCatalogOptions {
  env: HostEnv;
  docker: DockerClient;
  /** The engine image name. */
  image: () => string;
  getCache: (vendor: Vendor) => ModelCache | undefined;
  setCache: (cache: ModelCache, vendor: Vendor) => void;
  /** Gets the selected account directory, or the vendor's default account directory. */
  accountHome?: (vendor: Vendor, account?: string) => string | undefined;
}

export class ModelCatalog {
  constructor(private readonly options: ModelCatalogOptions) {}

  /** Lists model suggestions, reasoning levels, and the selected account's defaults. */
  async list(_dir?: string, account?: string, vendor: Vendor = "claude"): Promise<ModelsResult> {
    return this.result(vendor, account);
  }

  private result(vendor: Vendor, account?: string, scanned = false): ModelsResult {
    const cache = this.options.getCache(vendor);
    const cachedModels = cache?.models.length ? cache.models : undefined;
    const home = this.options.accountHome?.(vendor, account);
    const defaults = vendor === "claude" ? settingsDefaults(home) : vendorDefaults(vendor, home);
    const models =
      vendor === "claude"
        ? sortNewestFirst([
            ...new Set([
              ...(cachedModels ?? MODEL_BASELINE),
              ...accountModels(home ? path.join(home, ".claude.json") : undefined),
            ]),
          ])
        : [...new Set([...VENDOR_MODELS[vendor], ...(cachedModels ?? []), defaults.model])];
    return {
      models,
      efforts: [...VENDOR_EFFORT_LEVELS[vendor]],
      defaults,
      source: scanned ? "scan" : cachedModels ? "cache" : "baseline",
    };
  }

  /**
   * Rescans the image when the cache belongs to another image, is 30 days
   * old, or is empty. Returns whether the cache changed. Does nothing when
   * Docker or the image is missing.
   */
  async refreshIfStale(vendor: Vendor = "claude"): Promise<boolean> {
    let imageId: string | undefined;
    try {
      imageId = (await this.options.docker.inspectImage(this.options.image()))?.id;
    } catch {
      return false;
    }
    if (!imageId) return false;
    const cache = this.options.getCache(vendor);
    if (cache && cache.imageId === imageId && cache.models.length > 0) {
      const ageDays = (this.options.env.now().getTime() - Date.parse(cache.scannedAt)) / 86_400_000;
      if (ageDays < MODEL_CACHE_MAX_AGE_DAYS) return false;
    }
    return this.scan(imageId, vendor);
  }

  /**
   * Scans the image now. Throws `image_missing` when the image does not
   * exist. A scan that finds nothing keeps the old cache.
   */
  async rescan(_dir?: string, vendor: Vendor = "claude"): Promise<ModelsResult> {
    const image = await this.options.docker.inspectImage(this.options.image());
    if (!image) {
      throw new ApiError(
        "image_missing",
        `The image ${this.options.image()} does not exist. Build it first.`,
      );
    }
    const scanned = await this.scan(image.id, vendor);
    return this.result(vendor, undefined, scanned);
  }

  private async scan(imageId: string, vendor: Vendor): Promise<boolean> {
    let res;
    try {
      res = await this.options.docker.runOnce({
        image: this.options.image(),
        entrypoint: ["sh"],
        cmd: ["-c", scanCommand(vendor)],
        timeoutMs: 120_000,
      });
    } catch {
      return false;
    }
    if (res.exitCode !== 0) return false;
    const pattern = vendor === "claude" ? undefined : new RegExp(`^${MODEL_PATTERNS[vendor]}$`);
    const models = pattern
      ? [...new Set(res.stdout.split("\n").map((line) => line.trim()))].filter((id) =>
          pattern.test(id),
        )
      : parseScan(res.stdout);
    if (models.length === 0) return false; // an unexpected layout: keep the old list
    this.options.setCache(
      { imageId, scannedAt: this.options.env.now().toISOString(), models },
      vendor,
    );
    return true;
  }
}
