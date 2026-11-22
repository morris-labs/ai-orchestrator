// Primitives that more than one contract module uses.
import { z } from "zod";

/** An ISO 8601 timestamp with a time zone offset, such as `2026-10-28T09:00:00Z`. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** A TCP port number. */
export const PortSchema = z.number().int().min(1).max(65535);

/** A non-negative integer count. */
export const CountSchema = z.number().int().nonnegative();

/** A fraction between 0 and 1, inclusive. */
export const FractionSchema = z.number().min(0).max(1);

/**
 * The CLI that a box's main tmux session runs. The `known/` record omits the
 * `platform` key for `claude`.
 */
export const PlatformSchema = z.enum(["claude", "codex", "copilot"]);
export type Platform = z.infer<typeof PlatformSchema>;

/**
 * A model vendor in the review pipeline. Each vendor maps to one CLI, so the
 * values match `Platform`.
 */
export const VendorSchema = PlatformSchema;
export type Vendor = z.infer<typeof VendorSchema>;

/**
 * An account's short name, unique within its vendor: lowercase ASCII
 * letters, digits, and inner hyphens, at most 32 characters, such as
 * `personal` or `work`.
 */
export const AccountNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, {
  message: "use lowercase letters, digits, and inner hyphens, at most 32 characters",
});

/**
 * An account id, `VENDOR/NAME`, such as `claude/work`. See
 * `docs/accounts.md`.
 */
export const AccountIdSchema = z
  .string()
  .regex(/^(?:claude|codex|copilot)\/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, {
    message: "must have the form VENDOR/NAME, such as claude/work",
  });
export type AccountId = z.infer<typeof AccountIdSchema>;

/** Returns the id of the account `name` of `vendor`: `VENDOR/NAME`. */
export function accountId(vendor: Platform, name: string): string {
  return `${vendor}/${name}`;
}

/** Splits an account id into its vendor and name, or returns `null` for a malformed id. */
export function parseAccountId(id: string): { vendor: Platform; name: string } | null {
  if (!AccountIdSchema.safeParse(id).success) return null;
  const slash = id.indexOf("/");
  return { vendor: id.slice(0, slash) as Platform, name: id.slice(slash + 1) };
}

/** Reasoning effort values a box or review can request, in ascending order. */
export const EffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const VENDOR_EFFORT_LEVELS: Readonly<Record<Vendor, readonly Effort[]>> = {
  claude: CLAUDE_EFFORTS,
  codex: EffortSchema.options,
  copilot: EffortSchema.options,
};

export const ClaudeEffortSchema = EffortSchema.refine((level) =>
  VENDOR_EFFORT_LEVELS.claude.includes(level),
);

/** Gets the supported levels for models with known reasoning limits. */
export function modelEffortLevels(vendor: Vendor, model?: string): readonly Effort[] {
  const levels = VENDOR_EFFORT_LEVELS[vendor];
  if (vendor === "claude" || !model) return levels;
  if (
    /^gpt-(?:6(?:\.[12])?-(?:astra|sol|terra|luna)|5\.6-(?:sol|terra|luna)|daybreak-(?:blue|red)-latest)$/.test(
      model,
    )
  ) {
    return CLAUDE_EFFORTS;
  }
  if (/^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) {
    return ["minimal", "low", "medium", "high"];
  }
  if (/^gpt-5(?:[.-]|$)/.test(model)) return ["low", "medium", "high", "xhigh"];
  if (vendor === "codex" && model !== "codex-auto-review") {
    return ["minimal", "low", "medium", "high", "xhigh"];
  }
  return levels;
}

/** Selects the nearest effort for a review call and explains any substitution. */
export function resolveReviewEffort(
  requested: Effort | undefined,
  vendor: Vendor,
  model?: string,
): { effort?: Effort; note?: string } {
  if (!requested) return {};
  if (vendor === "copilot" && (!model || model.toLowerCase() === "auto")) {
    return {
      note: `Copilot uses its default effort instead of ${requested} with automatic model selection.`,
    };
  }
  const levels = modelEffortLevels(vendor, model);
  if (levels.includes(requested)) return { effort: requested };
  const rank = EffortSchema.options.indexOf(requested);
  const distance = (level: Effort) => Math.abs(EffortSchema.options.indexOf(level) - rank);
  const effort = levels.reduce((nearest, level) =>
    distance(level) < distance(nearest) ? level : nearest,
  );
  return { effort, note: `The ${vendor} call uses ${effort} effort instead of ${requested}.` };
}

/** A git commit SHA, abbreviated (7 or more hex digits) or full. */
export const CommitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

/** An environment variable name. */
export const EnvVarNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/**
 * A ULID: 26 Crockford base-32 characters, sortable by creation time. The
 * server mints run ids as ULIDs, so a run id is unique across every engine.
 */
export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/** A review run id. See `RunState.id`. */
export const RunIdSchema = UlidSchema;
export type RunId = z.infer<typeof RunIdSchema>;

/**
 * The stable, machine-readable error codes of both APIs.
 *
 * - `adoption_refused`: a running box holds the session (409).
 * - `session_tracked`: a stopped box holds the session; retry with
 *   `force: true` (409, `details.holders` lists the box ids).
 * - `box_running`: the action needs a stopped box (409).
 * - `stale_mounts`: the project container's mounts, ports, or secrets
 *   differ from the project's; restart it first (409).
 * - `secrets_locked`: the 1Password CLI is installed but not signed in (503).
 * - `secrets_unavailable`: the 1Password CLI is missing, or a reference
 *   doesn't resolve (503).
 * - `engine_mismatch`: the image's engine version differs from the
 *   server's; rebuild the image (409).
 * - `dirty_tree`: the working tree has uncommitted changes (409).
 * - `worktree_refused`: the worktree has changes, ignored files, or commits
 *   found nowhere else (409).
 * - `not_found`, `run_not_found`: no such resource (404).
 * - `conflict`: any other conflicting state (409).
 * - `validation`: the request doesn't match its schema (400).
 * - `unauthorized`: the bearer token or the session cookie is missing or
 *   wrong (401), or the caller's token is fine but the server refuses the
 *   call (403), such as a call that a link doesn't allow or a hub that
 *   refuses an enrollment code.
 * - `internal`: an unexpected failure on the server or the engine (500).
 * - `docker_unavailable`: the Docker daemon is unreachable (503).
 * - `image_missing`: the engine image doesn't exist (409).
 * - `invalid_state`: the run's status doesn't allow the action (409).
 * - `machine_offline`: the machine a request names is enrolled but not
 *   connected, or the link to the hub is down (503).
 * - `machine_timeout`: the machine a request names didn't answer in time
 *   (504).
 */
export const ApiErrorCodeSchema = z.enum([
  "adoption_refused",
  "session_tracked",
  "box_running",
  "stale_mounts",
  "secrets_locked",
  "secrets_unavailable",
  "engine_mismatch",
  "dirty_tree",
  "worktree_refused",
  "not_found",
  "conflict",
  "validation",
  "docker_unavailable",
  "image_missing",
  "run_not_found",
  "invalid_state",
  "unauthorized",
  "hub_unreachable",
  "internal",
  "machine_offline",
  "machine_timeout",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** The JSON body that every failed API call returns, on the server and the engine. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    /** A sentence for a person to read. */
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** The body of a successful call that has nothing else to return. */
export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;
