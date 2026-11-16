import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/store.js";
import { RunController } from "../../src/state/controller.js";
import { makeRun } from "./harness.js";

const fixtures = join(import.meta.dirname, "../run/fixtures");

describe("saved state compatibility", () => {
  for (const fixture of readdirSync(fixtures)) {
    it(`resumes saved example ${fixture} through the review pipeline`, async () => {
      const { repo, deps, run } = await makeRun({ request: { readOnly: true } });
      const saved = JSON.parse(readFileSync(join(fixtures, fixture), "utf8"));
      const store = new RunStore(repo, run.id);
      await store.writeJson("state.json", {
        ...saved,
        id: run.id,
        request: { ...saved.request, repoPath: repo, readOnly: true },
      });
      const loaded = await RunController.load(run.id, { projectRoot: repo }, deps);
      expect(loaded.state).toMatchObject({ status: "paused", stage: "preflight" });
      await loaded.resume();
      for (let attempt = 0; attempt < 600 && loaded.running; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(loaded.state).toMatchObject({ status: "finished", stage: "done" });
      expect(loaded.state.error).toBeUndefined();
    });
  }
});
