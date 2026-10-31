// Engine-owned checkouts. Read-only agent calls and reproduction scripts run
// in detached worktrees that the engine creates in the temporary directory,
// never in the checkout under review: a person, the box's own session, or
// another run edits that one, and the engine can't tell their changes from
// an agent's. Everything inside an engine checkout is the engine's, so
// restoring one after a read-only call changed it can't lose anyone's work.
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Git } from "../range/git.js";

/** What an engine checkout holds. */
export interface CheckoutState {
  /** The commit whose files the checkout holds. */
  commit: string;
  /**
   * The commit `HEAD` points at. When it differs from `commit`, the
   * difference shows as uncommitted changes, as it does in the checkout the
   * snapshot was taken from.
   */
  head: string;
}

/** The read-only checkout of a run: a temporary directory named after the run. */
export function readOnlyCheckoutPath(runId: string): string {
  return join(tmpdir(), `agentbox-tip-${runId}`);
}

/** The directory that holds a run's reproduction-script checkouts. */
export function scriptCheckoutsDir(runId: string): string {
  return join(tmpdir(), `agentbox-scripts-${runId}`);
}

/**
 * Removes a checkout and its entry in `git worktree list`. Never rejects.
 * Only ever called on a path the engine named after a run.
 */
export async function removeCheckout(git: Git, path: string): Promise<void> {
  try {
    await git.removeWorktree(path);
  } catch {
    // Nothing registered there.
  }
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  // Drops the entries of worktrees inside `path`, such as script checkouts.
  await git.ok(["worktree", "prune"]).catch(() => false);
}

/**
 * A detached worktree that the engine owns. `ensure()` creates it or moves
 * it to another state; `reset()` puts back the state it holds, which
 * deletes whatever an agent or a script created in it.
 */
export class EngineCheckout {
  private current: { key: string; state: CheckoutState; ready: Promise<string> } | null = null;

  constructor(
    private readonly git: Git,
    readonly dir: string,
  ) {}

  /** Creates the checkout, or moves it to `state`, and returns its path. */
  ensure(state: CheckoutState): Promise<string> {
    const key = `${state.commit}:${state.head}`;
    if (this.current?.key === key) return this.current.ready;
    // Parallel calls share one checkout, so the promise is the cache. A move
    // waits for the move before it.
    const previous = this.current?.ready.catch(() => null);
    const ready = (async () => {
      await previous;
      await removeCheckout(this.git, this.dir);
      await mkdir(dirname(this.dir), { recursive: true });
      try {
        await this.git.addDetachedWorktree(this.dir, state.commit);
        if (state.head !== state.commit) await this.inside(["reset", "-q", "--mixed", state.head]);
      } catch (error) {
        await removeCheckout(this.git, this.dir);
        throw error;
      }
      return this.dir;
    })();
    const entry = { key, state, ready };
    this.current = entry;
    // A failed checkout isn't cached, so the next call tries again.
    ready.catch(() => {
      if (this.current === entry) this.current = null;
    });
    return ready;
  }

  /**
   * Puts the checkout back to the state it holds: detaches `HEAD` at the
   * commit without moving any branch, discards every change, and deletes
   * every file the commit doesn't have, ignored files included. Returns
   * false when there is no checkout or git fails.
   */
  async reset(): Promise<boolean> {
    const entry = this.current;
    if (!entry) return false;
    const path = await entry.ready.catch(() => null);
    if (!path) return false;
    try {
      await this.inside(["checkout", "-q", "--detach", "--force", entry.state.commit]);
      await this.inside(["clean", "-q", "-ffdx"]);
      if (entry.state.head !== entry.state.commit) {
        await this.inside(["reset", "-q", "--mixed", entry.state.head]);
      }
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    const entry = this.current;
    this.current = null;
    if (!entry) return;
    await entry.ready.catch(() => null);
    await removeCheckout(this.git, this.dir);
  }

  /** Runs git in the checkout; `Git` runs none of the repository's hooks. */
  private async inside(args: readonly string[]): Promise<void> {
    await this.git.run(args, { cwd: this.dir });
  }
}
