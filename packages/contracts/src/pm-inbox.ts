// Delivery to the Project manager: the inbox of a build.
//
// The engine delivers each escalation and each digest to the Project
// manager's session as a one-line pointer to a file. The inbox records each
// item, whether its pointer reached the session, and, for an item that
// needs an answer, whether it got one. It lives in the build's
// `inbox.json` file, so it survives an engine restart. The server types
// each pointer into the session of the build's box once the box runs and
// the session shows its input prompt, then marks the item delivered.
import { z } from "zod";
import { BuildIdSchema, BuildSlugSchema } from "./build-events.js";
import { IsoDateTimeSchema } from "./common.js";

/**
 * What an inbox item points to: an escalation file, a digest that code
 * built, or a milestone's hand-off file, from which the Project manager
 * starts a fresh session.
 */
export const PmItemKindSchema = z.enum(["escalation", "digest", "handoff"]);
export type PmItemKind = z.infer<typeof PmItemKindSchema>;

/** The longest summary an item keeps, in characters, so its pointer stays one line. */
export const PM_SUMMARY_MAX = 200;

export const PmItemSchema = z.object({
  /** The item's ID in its build: `I1`, `I2`, and so on. */
  id: z.string().regex(/^I[1-9][0-9]*$/),
  kind: PmItemKindSchema,
  /**
   * What the item is about: the escalation ID, such as `E2`, or the
   * digest's or hand-off's name, such as `milestone-M1` or `release-ready`. A build has at
   * most one item for each kind and ref.
   */
  ref: z.string().min(1),
  /** One line that says what happened. */
  summary: z.string().min(1).max(PM_SUMMARY_MAX),
  /** The file the pointer names, relative to the build directory. */
  file: z.string().min(1),
  /** The same file as the container sees it, which the pointer names. */
  path: z.string().min(1),
  /** True for an item that waits for the Project manager's answer, such as an escalation. */
  needsAnswer: z.boolean(),
  createdAt: IsoDateTimeSchema,
  /** When the pointer reached the Project manager's session; `null` until it does. */
  deliveredAt: IsoDateTimeSchema.nullable(),
  /** When the item got its answer, such as a resolved escalation; `null` until it does. */
  answeredAt: IsoDateTimeSchema.nullable(),
});
export type PmItem = z.infer<typeof PmItemSchema>;

/** Whether an item still waits: its pointer wasn't delivered, or its answer didn't come. */
export function pmItemWaits(item: PmItem): boolean {
  return item.deliveredAt === null || (item.needsAnswer && item.answeredAt === null);
}

/**
 * The marker that starts an item's pointer. It names the build and the item,
 * so a session's transcript shows whether the pointer reached it already.
 */
export function pmMarker(slug: string, itemId: string): string {
  return `[aio-build ${slug} ${itemId}]`;
}

/** The one line that the engine types into the Project manager's session for an item. */
export function pmPointer(slug: string, item: Pick<PmItem, "id" | "summary" | "path">): string {
  const summary = item.summary.replace(/\s+/g, " ").trim();
  return `${pmMarker(slug, item.id)} ${summary} Read ${item.path}`;
}

/** The answer to an inbox request: the items that wait, oldest first, each with its pointer. */
export const PmInboxSchema = z.object({
  buildId: BuildIdSchema,
  slug: BuildSlugSchema,
  /** The box whose session gets the pointers, or `null` when no box runs the build. */
  boxId: z.string().min(1).nullable(),
  items: z.array(PmItemSchema.extend({ pointer: z.string().min(1) })),
});
export type PmInbox = z.infer<typeof PmInboxSchema>;

/** The payload of `build.inbox`: an item that the build added to its inbox. */
export const buildInboxFields = {
  buildId: BuildIdSchema,
  slug: BuildSlugSchema,
  /** The box whose session gets the pointer, or `null` when no box runs the build. */
  boxId: z.string().min(1).nullable(),
  item: PmItemSchema,
};
