// The engine image: its status, the engine version it carries, and builds.
import { ENGINE_VERSION_FILE, type ImageStatus } from "@agentbox/contracts";
import type { DockerClient, ImageBuildOptions } from "./types.js";

/** Image labels that W8's Dockerfile sets; the version files are the fallback. */
export const IMAGE_LABELS = {
  engineVersion: "agentbox.engine-version",
  claude: "agentbox.cli.claude",
  codex: "agentbox.cli.codex",
  copilot: "agentbox.cli.copilot",
} as const;

/** Files inside the image that name each version. */
export const VERSION_FILES = {
  engineVersion: ENGINE_VERSION_FILE,
  claude: "/etc/claude-code-version",
  codex: "/etc/codex-version",
  copilot: "/etc/copilot-version",
} as const;

type VersionKey = keyof typeof VERSION_FILES;

/** One `sh` command that prints `key=value` for each version file. */
export const VERSION_PROBE_COMMAND = (Object.entries(VERSION_FILES) as [VersionKey, string][])
  .map(([k, f]) => `printf '%s=' ${k}; head -n1 ${f} 2>/dev/null; echo`)
  .join("; ");

/** Parses the probe output into a map of trimmed, non-empty values. */
export function parseVersionProbe(output: string): Partial<Record<VersionKey, string>> {
  const out: Partial<Record<VersionKey, string>> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq) as VersionKey;
    const value = line.slice(eq + 1).trim();
    if (key in VERSION_FILES && value !== "") out[key] = value;
  }
  return out;
}

/**
 * Reads the versions an image carries: labels first, then the version files
 * through one throwaway container. Results are cached per image id.
 */
export class ImageVersions {
  private readonly cache = new Map<string, Partial<Record<VersionKey, string>>>();

  constructor(private readonly docker: DockerClient) {}

  async read(
    image: string,
  ): Promise<{ imageId: string; versions: Partial<Record<VersionKey, string>> } | null> {
    const info = await this.docker.inspectImage(image);
    if (!info) return null;
    const cached = this.cache.get(info.id);
    if (cached) return { imageId: info.id, versions: cached };
    const versions: Partial<Record<VersionKey, string>> = {};
    for (const key of Object.keys(IMAGE_LABELS) as VersionKey[]) {
      const v = info.labels[IMAGE_LABELS[key]];
      if (v) versions[key] = v.trim();
    }
    if (Object.keys(versions).length < Object.keys(VERSION_FILES).length) {
      try {
        const r = await this.docker.runOnce({
          image,
          entrypoint: ["sh"],
          cmd: ["-c", VERSION_PROBE_COMMAND],
          timeoutMs: 30000,
        });
        if (r.exitCode === 0) {
          for (const [k, v] of Object.entries(parseVersionProbe(r.stdout)) as [
            VersionKey,
            string,
          ][]) {
            versions[k] ??= v;
          }
        }
      } catch {
        // An image that cannot run keeps what its labels said.
      }
    }
    this.cache.set(info.id, versions);
    return { imageId: info.id, versions };
  }
}

/** The contract's image status. */
export async function imageStatus(
  versions: ImageVersions,
  docker: DockerClient,
  image: string,
  expectedEngineVersion: string,
): Promise<ImageStatus> {
  const info = await docker.inspectImage(image);
  const read = info ? await versions.read(image) : null;
  const v = read?.versions ?? {};
  return {
    name: image,
    exists: info !== null,
    imageId: info?.id ?? null,
    createdAt: info?.created ?? null,
    engineVersion: v.engineVersion ?? null,
    expectedEngineVersion,
    engineMatches: v.engineVersion === expectedEngineVersion,
    cliVersions: { claude: v.claude ?? null, codex: v.codex ?? null, copilot: v.copilot ?? null },
  };
}

/** The build kinds of `image.build`. */
export type ImageBuildKind = "rebuild" | "packages" | "claude-code";

/**
 * The build options for a kind, as 3.3.5's setup wizard ran them:
 * `rebuild` is `--no-cache --pull`; `packages` busts `CACHEBUST_PACKAGES` and
 * `claude-code` busts `CACHEBUST`, both with the current epoch seconds.
 */
export function imageBuildOptions(input: {
  kind: ImageBuildKind;
  context: string;
  tag: string;
  user: string;
  now: Date;
}): ImageBuildOptions {
  const epoch = String(Math.floor(input.now.getTime() / 1000));
  const buildArgs: Record<string, string> = { USER_NAME: input.user };
  if (input.kind === "packages") buildArgs.CACHEBUST_PACKAGES = epoch;
  if (input.kind === "claude-code") buildArgs.CACHEBUST = epoch;
  return {
    context: input.context,
    tag: input.tag,
    buildArgs,
    noCache: input.kind === "rebuild",
    pull: input.kind === "rebuild",
  };
}

/** The build as a person would type it, for a job's "Running: ..." label. */
export function imageBuildCommand(o: ImageBuildOptions): string {
  const parts = ["docker", "build", "-t", o.tag];
  if (o.noCache) parts.push("--no-cache");
  if (o.pull) parts.push("--pull");
  for (const [k, v] of Object.entries(o.buildArgs)) parts.push("--build-arg", `${k}=${v}`);
  parts.push(o.context);
  return parts.join(" ");
}
