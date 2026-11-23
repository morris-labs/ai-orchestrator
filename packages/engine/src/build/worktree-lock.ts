// Who changes the build worktree at a time: the drive, or the message turn
// of a seat that writes files. The drive holds the worktree through each
// step and lets go only while its own agent call runs, so a resumed
// Developer or Test engineer never changes files while the task gate, a red
// check, or a commit reads them.
//
// Lock order: the drive lets go of the worktree before it waits for a seat,
// and a message turn takes its seat before the worktree, so neither waits
// for a lock the other holds.

export class WorktreeLock {
  private locked = false;
  private readonly waiters: (() => void)[] = [];
  /** True while a drive step holds the worktree. */
  private driveHolds = false;

  private async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }

  /** Runs `turn` with the worktree to itself, such as a write seat's message turn. */
  async run<T>(turn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await turn();
    } finally {
      this.release();
    }
  }

  /** Runs a drive step, which holds the worktree except inside `outside()`. */
  async drive<T>(step: () => Promise<T>): Promise<T> {
    await this.acquire();
    this.driveHolds = true;
    try {
      return await step();
    } finally {
      this.driveHolds = false;
      this.release();
    }
  }

  /**
   * Lets message turns have the worktree while `call` runs, such as during
   * the drive's own agent call, and takes it back after. Outside a drive
   * step, it only runs `call`.
   */
  async outside<T>(call: () => Promise<T>): Promise<T> {
    if (!this.driveHolds) return call();
    this.driveHolds = false;
    this.release();
    try {
      return await call();
    } finally {
      await this.acquire();
      this.driveHolds = true;
    }
  }
}
