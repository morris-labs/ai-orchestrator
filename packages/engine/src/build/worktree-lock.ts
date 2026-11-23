// Who has the build worktree at a time: the drive, or one message turn. The
// drive holds the worktree through each step, its own agent calls included,
// and lets go only while it waits for a seat. So a resumed agent never
// changes files while the drive's agent works, the task gate, a red check,
// or a commit reads them, and nothing changes the worktree under a
// read-only turn, whose tree guard would count the change against it.
//
// Lock order: the drive lets go of the worktree before it waits for a seat,
// and takes it back once it holds the seat; a message turn takes its seat
// before the worktree. Neither waits for a lock that the other holds.

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
   * Lets message turns have the worktree while `call` waits, such as for a
   * seat, and takes it back after. `call` gets `reclaim`, which takes the
   * worktree back early, once the seat is the drive's. Outside a drive step,
   * it only runs `call`.
   */
  async outside<T>(call: (reclaim: () => Promise<void>) => Promise<T>): Promise<T> {
    if (!this.driveHolds) return call(() => Promise.resolve());
    this.driveHolds = false;
    this.release();
    let back = false;
    const reclaim = async () => {
      if (back) return;
      back = true;
      await this.acquire();
      this.driveHolds = true;
    };
    try {
      return await call(reclaim);
    } finally {
      await reclaim();
    }
  }
}
