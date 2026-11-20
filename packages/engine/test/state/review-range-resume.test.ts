import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@aio/contracts";
import { expect, it } from "vitest";
import { Git } from "../../src/range/git.js";
import { resolveRange } from "../../src/range/resolve.js";
import { resolveReviewRange } from "../../src/range/review-range.js";
import { RunStore } from "../../src/run/store.js";
import { RunController } from "../../src/state/controller.js";
import { makeRun } from "./harness.js";

it("resumes a saved mid-round run against its recorded working-tree snapshot", async () => {
  const { repo, deps, run } = await makeRun({ request: { readOnly: true, includeWorktree: true, roundCap: 1 } });
  writeFileSync(join(repo, "snapshot.txt"), "Saved review content\n");
  const state = { ...run.state, round: 1, status: "paused" as const, stage: "find" as const };
  const request = { ...state.request, includeWorktree: true };
  const resolved = await resolveRange(deps.runner, request);
  const first = await resolveReviewRange({ git: new Git(deps.runner, repo), resolved, request, policy: DEFAULT_POLICY });
  const legacy = readFileSync(join(import.meta.dirname, "../run/legacy-review-range-engine.json"), "utf8")
    .replaceAll("BRANCH_POINT", resolved.diffBaseSha).replaceAll("SNAPSHOT", first.tipCommit).replaceAll("TIP", resolved.tipSha);
  const store = new RunStore(repo, run.id);
  await store.writeJson("state.json", { ...state, stateVersion: 1 });
  await store.writeJson("engine.json", JSON.parse(legacy));
  await store.saveGroups(first.groups, 1);
  writeFileSync(join(repo, "snapshot.txt"), "Edit after the engine stopped\n");
  const loaded = await store.loadEngineState();
  expect(loaded.reviewRange?.tipCommit).toBe(first.tipCommit);
  expect(loaded.reviewRange?.linesAt).toBe(first.linesAt);
  const observed: string[] = [];
  for (const adapter of Object.values(deps.adapters)) {
    if (!adapter) continue;
    const review = adapter.review.bind(adapter);
    adapter.review = async (request) => {
      observed.push(readFileSync(join(request.repoPath, "snapshot.txt"), "utf8"));
      return review(request);
    };
  }
  const resumed = await RunController.load(run.id, { projectRoot: repo }, deps);
  await resumed.resume();
  for (let attempt = 0; attempt < 600 && resumed.running; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(resumed.state.error).toBeUndefined();
  expect(resumed.state.status).toBe("finished");
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every((content) => content === "Saved review content\n")).toBe(true);
  expect(readFileSync(join(repo, "snapshot.txt"), "utf8")).toBe("Edit after the engine stopped\n");
});
