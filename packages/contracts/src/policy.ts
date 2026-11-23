// The repository policy file, `<project>/.aio/policy.yaml` by default
// (see `ProjectSettings.policyPath`). The file is git-excluded and the review
// app edits it. Keys use the same camelCase as the schema, and unknown keys
// are rejected so a misspelled key fails loudly.
import { z } from "zod";
import { TierModelsSchema, TierPathRuleSchema } from "./tiers.js";

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  /** The rule as reviewers and verifiers read it in their prompts. */
  text: z.string().min(1),
  /** Globs that limit the rule to some files. Absent means every file. */
  appliesTo: z.array(z.string().min(1)).optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

/** A command the gate runs, from `cwd` (relative to the repository) or the repository root. */
export const PolicyCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
});
export type PolicyCommand = z.infer<typeof PolicyCommandSchema>;

export const DEFAULT_GROUP_SIZE_LIMIT = 400;

export const PolicyFileSchema = z
  .object({
    version: z.literal(1),
    /** Globs whose files always count as major. */
    riskPaths: z.array(z.string().min(1)).default([]),
    rules: z.array(PolicyRuleSchema).default([]),
    tests: z.array(PolicyCommandSchema).default([]),
    /** Type check commands. A build plan's type check list starts from this one. */
    typecheck: z.array(PolicyCommandSchema).optional(),
    lint: z.array(PolicyCommandSchema).default([]),
    /** Facts about where the code runs, such as "Windows-only code paths under win/". */
    environmentLimits: z.array(z.string().min(1)).default([]),
    /** A group with more changed lines than this splits into smaller groups. */
    groupSizeLimit: z.number().int().positive().default(DEFAULT_GROUP_SIZE_LIMIT),
    /**
     * GitHub logins whose pull request comments the post-push loop imports.
     * The loop always imports Copilot's comments. When set, this list
     * replaces the repository's collaborators; absent means the
     * collaborators. Logins are case-insensitive.
     */
    commentAuthors: z.array(z.string().min(1)).optional(),
    /** Models per vendor and tier, over the built-in mappings. Refuses a blocked model. */
    tierModels: TierModelsSchema.optional(),
    /** Globs of files that no run groups or reviews, at every scope. */
    excludePaths: z.array(z.string().min(1)).optional(),
    /** Tiers for paths; the first rule that matches a file wins. */
    tierPaths: z.array(TierPathRuleSchema).optional(),
  })
  .strict();
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

/** The policy a repository gets when it has no policy file. */
export const DEFAULT_POLICY: PolicyFile = PolicyFileSchema.parse({ version: 1 });
