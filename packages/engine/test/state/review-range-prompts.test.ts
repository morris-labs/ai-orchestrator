import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FakeClock, GrantingBroker, MemoryEventSink } from "../../src/core.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { RunController } from "../../src/state/controller.js";
import { uniqueRunId } from "./run-ids.js";
import { Scenario, buildSampleRepo } from "./scenario.js";

it("names the commits that produce the find, sweep, and confirm diffs", async () => {
  const repo = buildSampleRepo();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const branchPoint = git("rev-parse", "main");
  const tip = git("rev-parse", "HEAD");
  git("switch", "-q", "-c", "moved-base", "main");
  writeFileSync(join(repo, "base-only.txt"), "Added on the named base branch.\n");
  git("add", "base-only.txt");
  git("commit", "-qm", "Advance the named base");
  git("switch", "-q", "feature");

  const scenario = new Scenario();
  const clock = new FakeClock();
  const run = await RunController.create(
    {
      runId: uniqueRunId(),
      projectId: "sample",
      repoPath: repo,
      base: "moved-base",
      depth: "thorough",
      roundCap: 1,
    },
    { projectRoot: repo },
    {
      adapters: scenario.adapters(),
      broker: new GrantingBroker(clock),
      events: new MemoryEventSink("engine:test", "stream-test", clock),
      runner: new ExecaRunner(),
      clock,
      container: "aio-agent-proj-sample",
    },
  );
  await run.start();
  const state = await run.settled();
  expect(state.error).toBeUndefined();

  for (const method of ["review", "sweep", "confirm"] as const) {
    const prompts = scenario.calls.filter((call) => call.method === method);
    expect(prompts.length, method).toBeGreaterThan(0);
    for (const { prompt } of prompts) {
      const range = /(?:change|fix diff) from ([0-9a-f]{40}) to ([0-9a-f]{40})/.exec(prompt);
      expect(range, method).not.toBeNull();
      const [, from, to] = range!;
      expect(from).toBe(method === "confirm" ? tip : branchPoint);
      expect(to).toBe(method === "confirm" ? git("rev-parse", "HEAD") : tip);
      const files = [...prompt.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map(
        (match) => match[1]!,
      );
      expect(files.length, method).toBeGreaterThan(0);
      expect(
        git("diff", "--name-only", from!, to!, "--", ...files)
          .split("\n")
          .sort(),
      ).toEqual([...new Set(files)].sort());
    }
  }
  expect(
    scenario.calls.some(
      (call) =>
        call.prompt.includes(`Branch point (${branchPoint})`) ||
        call.prompt.includes(`branch point (${branchPoint})`),
    ),
  ).toBe(true);
});
