// Build pipeline specialties: named packs of guidance for one technology,
// such as Node.js or Go, that a task gives to every agent that works on it.
// A specialty names a skill in the account's skills folder or a file in the
// repository's specialties directory. See `docs/build-pipeline/specialties.md`.
import { z } from "zod";
import { TEAM_DIR } from "./build-roles.js";

/** The directory, relative to a repository root, that holds its own specialties. */
export const SPECIALTIES_DIR = `${TEAM_DIR}/specialties`;

/**
 * A specialty name: lowercase letters, digits, and inner hyphens, such as
 * `typescript-dev`. It is also the name of the skill folder or the file that
 * holds the pack, so it can't name a path.
 */
export const SpecialtyNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, {
  message: "use lowercase letters, digits, and inner hyphens, at most 64 characters",
});
export type SpecialtyName = z.infer<typeof SpecialtyNameSchema>;

/** The specialties of one task in a build plan: none by default, each named once. */
export const TaskSpecialtiesSchema = z
  .array(SpecialtyNameSchema)
  .default([])
  .superRefine((names, ctx) => {
    const seen = new Set<string>();
    for (const [index, name] of names.entries()) {
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `the specialty ${name} appears more than once`,
        });
      }
      seen.add(name);
    }
  });
export type TaskSpecialties = z.infer<typeof TaskSpecialtiesSchema>;

/** Where a specialty's pack came from: the repository or an account's skills folder. */
export const SpecialtySourceSchema = z.enum(["repository", "account"]);
export type SpecialtySource = z.infer<typeof SpecialtySourceSchema>;
