// The engine image: its status, the engine version it carries, and builds.
import { ENGINE_VERSION_FILE, type ImageStatus } from "@aio/contracts";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DockerClient } from "./types.js";

/** Image labels that W8's Dockerfile sets; the version files are the fallback. */
export const IMAGE_LABELS = {
  engineVersion: "aio.engine-version",
  claude: "aio.cli.claude",
  codex: "aio.cli.codex",
  copilot: "aio.cli.copilot",
} as const;

/** Files inside the image that name each version. */
export const VERSION_FILES = {
  engineVersion: ENGINE_VERSION_FILE,
  claude: "/etc/claude-code-version",
  codex: "/etc/codex-version",
  copilot: "/etc/copilot-version",
} as const;

type VersionKey = keyof typeof VERSION_FILES;

/**
 * The npm package of each agent CLI. An image whose Dockerfile wrote no
 * version file for a CLI, as the first image did for Codex and Copilot,
 * still reports the version from the package's `package.json`.
 */
export const CLI_PACKAGES: Partial<Record<VersionKey, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  copilot: "@github/copilot",
};

/**
 * Builds one POSIX `sh` command that prints `key=value` for each version
 * file. When a CLI's file is missing, it reads the version from the
 * package's `package.json` under `npm root -g`, using the `node` and `npm`
 * that the image's `PATH` finds. `files` exists for tests.
 */
export function versionProbeCommand(
  files: Record<VersionKey, string> = VERSION_FILES,
  packages: Partial<Record<VersionKey, string>> = CLI_PACKAGES,
): string {
  return (Object.entries(files) as [VersionKey, string][])
    .map(([k, f]) => {
      const pkg = packages[k];
      const fallback = pkg
        ? ` || node -p "require(process.argv[1] + '/${pkg}/package.json').version" "$(npm root -g 2>/dev/null)" 2>/dev/null`
        : "";
      return `printf '%s=' ${k}; { head -n1 ${f} 2>/dev/null${fallback}; }; echo`;
    })
    .join("; ");
}

/** The probe against the image's own version files. */
export const VERSION_PROBE_COMMAND = versionProbeCommand();

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

/** The error for an engine image without an AI Orchestrator engine. */
export function noEngineMessage(image: string): string {
  return `The image ${image} has no AI Orchestrator engine. Rebuild the image from AI Orchestrator.`;
}

/** The build kinds of `image.build`. */
export type ImageBuildKind = "rebuild" | "packages" | "claude-code";

/**
 * The `scripts/build-image.sh` options for a build kind, as 3.3.5's setup
 * wizard ran them: `rebuild` is `--no-cache` (which also pulls the base
 * image), `packages` busts `CACHEBUST_PACKAGES`, and `claude-code` busts
 * `CACHEBUST`.
 */
export function imageBuildScriptArgs(kind: ImageBuildKind): string[] {
  switch (kind) {
    case "rebuild":
      return ["--no-cache"];
    case "packages":
      return ["--update-packages"];
    case "claude-code":
      return ["--update-cli"];
  }
}

/**
 * The build script for an image build context. The script and the context
 * sit side by side, in a source checkout (`scripts/` and `image/`) and in the
 * installed package (`/usr/share/ai-orchestrator/scripts` and
 * `/usr/share/ai-orchestrator/image`). The script builds `../image` from its own
 * directory, so the context must be a directory named `image`.
 */
export function imageBuildScript(context: string): string {
  return path.join(path.dirname(path.resolve(context)), "scripts", "build-image.sh");
}

/** Where the installed package puts the image build context. */
export const INSTALLED_IMAGE_CONTEXT = "/usr/share/ai-orchestrator/image";

/**
 * The image build context when `AIO_IMAGE_CONTEXT` isn't set: `image/`
 * in the source checkout at `repoRoot` when it has a Dockerfile, else the
 * installed package's context, else `image/` in `shareDir`, where the
 * macOS and Windows packages put it beside the server.
 */
export function defaultImageContext(
  repoRoot: string,
  exists: (p: string) => boolean = existsSync,
  shareDir?: string,
): string {
  const checkout = path.join(repoRoot, "image");
  if (exists(path.join(checkout, "Dockerfile"))) return checkout;
  if (exists(path.join(INSTALLED_IMAGE_CONTEXT, "Dockerfile"))) return INSTALLED_IMAGE_CONTEXT;
  if (shareDir && exists(path.join(shareDir, "image", "Dockerfile"))) {
    return path.join(shareDir, "image");
  }
  return checkout;
}
