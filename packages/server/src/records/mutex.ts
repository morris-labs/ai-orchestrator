// Serializes async work per key, such as every container start of one project.

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Runs `fn` after every earlier call with the same key has settled. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
