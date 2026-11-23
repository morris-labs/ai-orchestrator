// The Project manager's inbox of a build, in `inbox.json`: one item for each
// escalation and each digest, with the one-line pointer that the server
// types into the Project manager's session. An item waits until its pointer
// is delivered and, when it needs an answer, until it gets one. The file
// keeps the inbox across an engine restart. See `pm-inbox.ts` in contracts.
import { z } from "zod";
import {
  PM_SUMMARY_MAX,
  PmItemSchema,
  pmItemWaits,
  pmPointer,
  type PmInbox,
  type PmItem,
  type PmItemKind,
} from "@aio/contracts";
import { readJson, writeJsonAtomic } from "../run/files.js";

const InboxFileSchema = z.object({ version: z.literal(1), items: z.array(PmItemSchema) });

/** What a step adds to the inbox. */
export interface PmItemDraft {
  kind: PmItemKind;
  ref: string;
  summary: string;
  /** The file, relative to the build directory. */
  file: string;
  needsAnswer: boolean;
}

/** Shortens `text` to one line of at most `PM_SUMMARY_MAX` characters. */
export function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= PM_SUMMARY_MAX ? line : `${line.slice(0, PM_SUMMARY_MAX - 3)}...`;
}

export class PmInboxFile {
  /** Serializes every read and write, so two changes never race. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    /** The inbox file, such as `.aio/builds/SLUG/inbox.json`. */
    readonly file: string,
    /** Turns a path relative to the build directory into the path the container sees. */
    private readonly pathOf: (file: string) => string,
    private readonly now: () => string,
  ) {}

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<PmItem[]> {
    return (await readJson(this.file, InboxFileSchema))?.items ?? [];
  }

  private write(items: PmItem[]): Promise<void> {
    return writeJsonAtomic(this.file, { version: 1, items });
  }

  /**
   * Adds an item and returns it, or returns `null` when the inbox holds an
   * item of the same kind and ref already.
   */
  add(draft: PmItemDraft): Promise<PmItem | null> {
    return this.queue(async () => {
      const items = await this.read();
      if (items.some((i) => i.kind === draft.kind && i.ref === draft.ref)) return null;
      const item = PmItemSchema.parse({
        id: `I${items.length + 1}`,
        kind: draft.kind,
        ref: draft.ref,
        summary: oneLine(draft.summary),
        file: draft.file,
        path: this.pathOf(draft.file),
        needsAnswer: draft.needsAnswer,
        createdAt: this.now(),
        deliveredAt: null,
        answeredAt: null,
      });
      await this.write([...items, item]);
      return item;
    });
  }

  /** Marks an item delivered and returns it; a second mark keeps the first time. `null` for an unknown item. */
  delivered(id: string): Promise<PmItem | null> {
    return this.change(
      (i) => i.id === id,
      (i) => ({ ...i, deliveredAt: i.deliveredAt ?? this.now() }),
    );
  }

  /** Marks the item of `kind` and `ref` answered, when the inbox holds one. */
  async answered(kind: PmItemKind, ref: string): Promise<void> {
    await this.change(
      (i) => i.kind === kind && i.ref === ref,
      (i) => ({ ...i, answeredAt: i.answeredAt ?? this.now() }),
    );
  }

  private change(
    match: (i: PmItem) => boolean,
    next: (i: PmItem) => PmItem,
  ): Promise<PmItem | null> {
    return this.queue(async () => {
      const items = await this.read();
      const at = items.findIndex(match);
      const found = items[at];
      if (!found) return null;
      const changed = next(found);
      if (JSON.stringify(changed) !== JSON.stringify(found)) {
        items[at] = changed;
        await this.write(items);
      }
      return changed;
    });
  }

  /** Every item, oldest first. */
  list(): Promise<PmItem[]> {
    return this.queue(() => this.read());
  }

  /** The inbox as a request answers it: the items that wait, or with `all` every item, each with its pointer. */
  async view(
    build: { id: string; slug: string; boxId: string | null },
    all = false,
  ): Promise<PmInbox> {
    const items = (await this.list()).filter((i) => all || pmItemWaits(i));
    return {
      buildId: build.id,
      slug: build.slug,
      boxId: build.boxId,
      items: items.map((i) => ({ ...i, pointer: pmPointer(build.slug, i) })),
    };
  }
}
