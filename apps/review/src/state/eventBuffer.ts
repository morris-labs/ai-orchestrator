// Keeps the stream's changes that arrive while a REST load runs, so the
// load's answer, which can predate them, doesn't drop or revert them.

/** One load's record of the items events changed while it ran. */
export type LoadRecord<T> = Map<string, T>;

export class EventBuffer<T> {
  private readonly active = new Set<LoadRecord<T>>();

  /** Starts recording for a load. Pass the result to `finish` or `cancel`. */
  start(): LoadRecord<T> {
    const record: LoadRecord<T> = new Map();
    this.active.add(record);
    return record;
  }

  /** Records an item an event changed; every running load gets it. */
  record(id: string, item: T): void {
    for (const r of this.active) r.set(id, item);
  }

  /** Stops recording for a load whose answer won't be used. */
  cancel(record: LoadRecord<T>): void {
    this.active.delete(record);
  }

  /**
   * Ends a load: the loaded items, with each item an event changed meanwhile
   * put back over its loaded copy when `newer(event, loaded)` allows, and
   * the items only events know added.
   */
  finish(
    record: LoadRecord<T>,
    loaded: readonly T[],
    idOf: (item: T) => string,
    newer: (fromEvent: T, fromLoad: T) => boolean = () => true,
  ): T[] {
    this.active.delete(record);
    const ids = new Set(loaded.map(idOf));
    const out = loaded.map((item) => {
      const changed = record.get(idOf(item));
      return changed !== undefined && newer(changed, item) ? changed : item;
    });
    for (const [id, item] of record) if (!ids.has(id)) out.push(item);
    return out;
  }
}
