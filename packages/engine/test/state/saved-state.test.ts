import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GrantingBroker, MemoryEventSink } from "../../src/core.js";
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

  it("continues a saved run's lease and agent ids through the shared call core", async () => {
    const { repo, deps, run } = await makeRun({ request: { readOnly: true } });
    const saved = JSON.parse(readFileSync(join(fixtures, "v2.json"), "utf8"));
    const store = new RunStore(repo, run.id);
    await store.writeJson("state.json", {
      ...saved,
      id: run.id,
      request: { ...saved.request, repoPath: repo, readOnly: true },
    });
    // The engine.json fields the agent-call core reads, as the engine wrote
    // them before the core moved out of the run context: the ids it handed
    // out and a limit that has passed.
    const engine = await store.readJson<Record<string, unknown>>("engine.json");
    await store.writeJson("engine.json", {
      ...engine,
      counters: { finding: 0, agent: 4, lease: 5 },
      limitedVendors: { codex: { until: "2020-01-01T00:00:00.000Z", message: "usage limit" } },
    });
    const loaded = await RunController.load(run.id, { projectRoot: repo }, deps);
    await loaded.resume();
    for (let attempt = 0; attempt < 600 && loaded.running; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(loaded.state.error).toBeUndefined();
    expect(loaded.state).toMatchObject({ status: "finished", stage: "done" });
    const leases = (deps.broker as GrantingBroker).requests.map((r) => r.leaseId);
    expect(leases[0]).toBe(`${run.id}-L6`);
    const agents = (deps.events as MemoryEventSink).ofType("agent.started").map((e) => e.agentId);
    expect(agents[0]).toBe(`${run.id}-A5`);
  });
});
