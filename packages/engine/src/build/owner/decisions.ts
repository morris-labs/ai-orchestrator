// The decisions of a build: one file for each owner post, in
// `decisions/ID.json`, attached to the post's task or milestone. Every
// later agent on the task gets the decisions in its prompt, and the Scribe
// reads the folder at release.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BuildDecisionSchema,
  type BuildDecision,
  type BuildPlan,
  type Message,
  type PlanChangeFlag,
} from "@aio/contracts";
import { readJson, writeJsonAtomic } from "../../run/files.js";

const DECISION_FILE = /^D([1-9][0-9]*)\.json$/;

export class DecisionLog {
  /** Serializes every read and write, so a flag never races the record it changes. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    /** The folder of the decision files, such as `.aio/builds/SLUG/decisions`. */
    readonly dir: string,
    private readonly buildId: string,
  ) {}

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Records an owner post as the build's next decision. A post recorded already returns its decision. */
  record(message: Message): Promise<BuildDecision> {
    return this.queue(async () => {
      const all = await this.read();
      const known = all.find((d) => d.messageId === message.id);
      if (known) return known;
      const decision = BuildDecisionSchema.parse({
        version: 1,
        id: `D${all.length + 1}`,
        buildId: this.buildId,
        messageId: message.id,
        to: message.to,
        taskId: message.taskId,
        milestone: message.milestone,
        body: message.body,
        createdAt: message.createdAt,
        planChange: null,
      });
      await writeJsonAtomic(join(this.dir, `${decision.id}.json`), decision);
      return decision;
    });
  }

  /** Every decision of the build, oldest first. */
  list(): Promise<BuildDecision[]> {
    return this.queue(() => this.read());
  }

  /** The decision that records owner post `messageId`, or `null`. */
  async byMessage(messageId: string): Promise<BuildDecision | null> {
    return (await this.list()).find((d) => d.messageId === messageId) ?? null;
  }

  /**
   * Adds a plan change flag to the decision that records `messageId`.
   * Returns `null` when no decision records it or it holds a flag already.
   */
  flag(messageId: string, flag: PlanChangeFlag): Promise<BuildDecision | null> {
    return this.queue(async () => {
      const decision = (await this.read()).find((d) => d.messageId === messageId);
      if (!decision || decision.planChange) return null;
      const flagged = { ...decision, planChange: flag };
      await writeJsonAtomic(join(this.dir, `${decision.id}.json`), flagged);
      return flagged;
    });
  }

  private async read(): Promise<BuildDecision[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const numbers = names
      .map((name) => DECISION_FILE.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    const decisions: BuildDecision[] = [];
    for (const n of numbers) {
      const decision = await readJson(join(this.dir, `D${n}.json`), BuildDecisionSchema);
      if (decision) decisions.push(decision);
    }
    return decisions;
  }
}

/** The milestone of the plan that holds task `taskId`, or `null`. */
export function milestoneOfTask(plan: BuildPlan, taskId: string | null): string | null {
  if (taskId === null) return null;
  return plan.milestones.find((m) => m.tasks.includes(taskId))?.id ?? null;
}

/**
 * The decisions attached to any of `taskIds`: the ones about one of the
 * tasks, and the ones about the milestone of one of them.
 */
export function decisionsFor(
  decisions: readonly BuildDecision[],
  taskIds: readonly string[],
  plan: BuildPlan,
): BuildDecision[] {
  const milestones = new Set(
    taskIds.map((id) => milestoneOfTask(plan, id)).filter((m): m is string => m !== null),
  );
  return decisions.filter((d) =>
    d.taskId !== null
      ? taskIds.includes(d.taskId)
      : d.milestone !== null && milestones.has(d.milestone),
  );
}

/** Text as a Markdown block quote. */
const quote = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** The decisions as a prompt section's body; empty for none. */
export function decisionsText(decisions: readonly BuildDecision[]): string {
  if (decisions.length === 0) return "";
  return [
    "The owner decided the following for this task. Work from these decisions and don't undo them. When a decision contradicts an acceptance criterion, follow the decision and say so in your answer.",
    ...decisions.map(
      (d) =>
        `${d.id} (owner post ${d.messageId}, ${d.createdAt}${d.planChange ? `; flagged as a plan change against ${d.planChange.criteria.join(", ")}` : ""}):\n${quote(d.body)}`,
    ),
  ].join("\n\n");
}
