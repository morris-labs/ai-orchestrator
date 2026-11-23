// Build pipeline role definitions: the front matter of a role file in the
// engine's role library or in a repository's `.aio/team/` directory. See
// `docs/build-pipeline/roles.md`.
import { z } from "zod";
import { EffortSchema, VendorSchema } from "./common.js";
import { ModelTierSchema } from "./tiers.js";

/** The directory, relative to a repository root, that holds its own roles. */
export const TEAM_DIR = ".aio/team";

/** A role name: lowercase letters, digits, and inner hyphens, such as `test-engineer`. */
export const RoleNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, {
  message: "use lowercase letters, digits, and inner hyphens, at most 64 characters",
});
export type RoleName = z.infer<typeof RoleNameSchema>;

/** When the engine seats a role: every build, from project traits, or on a trigger. */
export const RoleGroupSchema = z.enum(["core", "bench", "on-call"]);
export type RoleGroup = z.infer<typeof RoleGroupSchema>;

/** How an active role contributes: an agent in a seat, or a focus area for the review pipeline. */
export const RoleFormSchema = z.enum(["seat", "lens"]);
export type RoleForm = z.infer<typeof RoleFormSchema>;

export const RoleActivationSchema = z
  .object({
    group: RoleGroupSchema,
    /** The project trait or trigger that seats the role, in words. Core roles omit it. */
    when: z.string().min(1).optional(),
    form: RoleFormSchema.default("seat"),
  })
  .strict();
export type RoleActivation = z.infer<typeof RoleActivationSchema>;

export const RoleInputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type RoleInput = z.infer<typeof RoleInputSchema>;

export const RoleOutputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    /** A JSON schema for the output, when the agent answers with a JSON object. */
    schema: z.record(z.unknown()).optional(),
  })
  .strict();
export type RoleOutput = z.infer<typeof RoleOutputSchema>;

/** What a role's agent can change: nothing, or the files that match its path globs. */
export const RolePermissionSchema = z.discriminatedUnion("access", [
  z.object({ access: z.literal("read-only") }).strict(),
  z
    .object({
      access: z.literal("write"),
      /** Repository-relative globs. `{owned}` stands for the task's owned files. */
      paths: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
export type RolePermission = z.infer<typeof RolePermissionSchema>;

/** A role's default placement: the first of the placement levels. */
export const RolePlacementSchema = z
  .object({
    vendor: VendorSchema,
    tier: ModelTierSchema,
    effort: EffortSchema,
  })
  .strict();
export type RolePlacement = z.infer<typeof RolePlacementSchema>;

/** A role file's front matter. Every field is required and no other field is allowed. */
export const RoleFrontMatterSchema = z
  .object({
    name: RoleNameSchema,
    /** The name people read, such as `Test engineer`. */
    title: z.string().min(1),
    purpose: z.string().min(1),
    activation: RoleActivationSchema,
    inputs: z.array(RoleInputSchema),
    outputs: z.array(RoleOutputSchema).min(1),
    permission: RolePermissionSchema,
    placement: RolePlacementSchema,
    /** How long one turn of the role's agent can run before the engine stops it. */
    turnTimeoutMinutes: z.number().int().positive().max(24 * 60),
    rules: z.array(z.string().min(1)),
  })
  .strict();
export type RoleFrontMatter = z.infer<typeof RoleFrontMatterSchema>;

/** Where a loaded role came from. */
export const RoleSourceSchema = z.enum(["library", "repository"]);
export type RoleSource = z.infer<typeof RoleSourceSchema>;

/** A loaded role: its front matter, its Markdown body, and its origin. */
export const RoleDefinitionSchema = RoleFrontMatterSchema.extend({
  /** The Markdown body of the role file: the role's standing instructions. */
  instructions: z.string(),
  source: RoleSourceSchema,
  /** The file the role came from. */
  path: z.string().min(1),
}).strict();
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;
