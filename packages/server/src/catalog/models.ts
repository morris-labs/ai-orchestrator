// The model list for the New Box form (port of `ModelCatalog.cpp`): a
// built-in baseline, the ids scanned from the Claude Code program inside the
// engine image (cached against the image id), and the account's extra
// options from `~/.claude.json`.
import fs from "node:fs";
import path from "node:path";
import {
  EffortSchema,
  type Effort,
  type ModelCache,
  type ModelsResultSchema,
} from "@agentbox/contracts";
import type { z } from "zod";
import type { DockerClient } from "../docker/types.js";
import type { HostEnv } from "../records/env.js";
import { homePaths } from "../records/env.js";
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

/** The `--effort` values, lowest first. */
export const EFFORTS: readonly Effort[] = EffortSchema.options;

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

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The account's extra model options, from `~/.claude.json` `additionalModelOptionsCache[].value`. */
export function accountModels(env: HostEnv): string[] {
  const root = readJsonObject(homePaths(env).claudeJson);
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

/**
 * What `claude` would use in `dir`: `model` and `effortLevel` from
 * `<dir>/.claude/settings.local.json`, `<dir>/.claude/settings.json`, then
 * `~/.claude/settings.json`, the precedence Claude Code applies.
 */
export function settingsDefaults(env: HostEnv, dir?: string): { model: string; effort: Effort } {
  const files: string[] = [];
  if (dir) {
    files.push(path.join(dir, ".claude", "settings.local.json"));
    files.push(path.join(dir, ".claude", "settings.json"));
  }
  files.push(path.join(homePaths(env).claudeDir, "settings.json"));
  let model: string | undefined;
  let effort: Effort | undefined;
  for (const file of files) {
    const obj = readJsonObject(file);
    if (!obj) continue;
    if (model === undefined && typeof obj.model === "string" && obj.model !== "") model = obj.model;
    if (effort === undefined) {
      const e = EffortSchema.safeParse(obj.effortLevel);
      if (e.success) effort = e.data;
    }
  }
  return { model: model ?? FALLBACK_MODEL, effort: effort ?? FALLBACK_EFFORT };
}

export interface ModelCatalogOptions {
  env: HostEnv;
  docker: DockerClient;
  /** The engine image name. */
  image: () => string;
  getCache: () => ModelCache | undefined;
  setCache: (cache: ModelCache) => void;
}

export class ModelCatalog {
  constructor(private readonly options: ModelCatalogOptions) {}

  /** The cached scan (or the baseline) plus the account's extra models, sorted. */
  known(): string[] {
    const cache = this.options.getCache();
    const ids = cache && cache.models.length > 0 ? [...cache.models] : [...MODEL_BASELINE];
    for (const id of accountModels(this.options.env)) if (!ids.includes(id)) ids.push(id);
    return sortNewestFirst(ids);
  }

  /** The model list, the efforts, and what `claude` would use in `dir`. */
  async list(dir?: string): Promise<ModelsResult> {
    const cache = this.options.getCache();
    return this.result(dir, cache && cache.models.length > 0 ? "cache" : "baseline");
  }

  private result(dir: string | undefined, source: ModelsResult["source"]): ModelsResult {
    return {
      models: this.known(),
      efforts: [...EFFORTS],
      defaults: settingsDefaults(this.options.env, dir),
      source,
    };
  }

  /**
   * Rescans the image when the cache belongs to another image, is 30 days
   * old, or is empty. Returns whether the cache changed. Does nothing when
   * Docker or the image is missing.
   */
  async refreshIfStale(): Promise<boolean> {
    let imageId: string | undefined;
    try {
      imageId = (await this.options.docker.inspectImage(this.options.image()))?.id;
    } catch {
      return false;
    }
    if (!imageId) return false;
    const cache = this.options.getCache();
    if (cache && cache.imageId === imageId && cache.models.length > 0) {
      const ageDays = (this.options.env.now().getTime() - Date.parse(cache.scannedAt)) / 86_400_000;
      if (ageDays < MODEL_CACHE_MAX_AGE_DAYS) return false;
    }
    return this.scan(imageId);
  }

  /**
   * Scans the image now. Throws `image_missing` when the image does not
   * exist. A scan that finds nothing keeps the old cache.
   */
  async rescan(dir?: string): Promise<ModelsResult> {
    const image = await this.options.docker.inspectImage(this.options.image());
    if (!image) {
      throw new ApiError(
        "image_missing",
        `The image ${this.options.image()} does not exist. Build it first.`,
      );
    }
    const scanned = await this.scan(image.id);
    return scanned ? this.result(dir, "scan") : this.list(dir);
  }

  private async scan(imageId: string): Promise<boolean> {
    let res;
    try {
      res = await this.options.docker.runOnce({
        image: this.options.image(),
        entrypoint: ["sh"],
        cmd: ["-c", MODEL_SCAN_COMMAND],
        timeoutMs: 120_000,
      });
    } catch {
      return false;
    }
    if (res.exitCode !== 0) return false;
    const models = parseScan(res.stdout);
    if (models.length === 0) return false; // an unexpected layout: keep the old list
    this.options.setCache({ imageId, scannedAt: this.options.env.now().toISOString(), models });
    return true;
  }
}
