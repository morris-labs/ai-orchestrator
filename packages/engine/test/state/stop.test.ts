// The clean stop and the decisions that come before any stop.
import { FindingInputSchema, type Finding, type Verdict } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { DecisionNeeded } from "../../src/state/context.js";
import { drivePrePush, endRound } from "../../src/state/prepush.js";
import { makeRun } from "./harness.js";

function finding(id: string, verdict: Verdict, runId: string): Finding {
  return FindingInputSchema.parse({
    id,
    fingerprint: id,
    severity: "P1",
    title: `Bug ${id}`,
    file: "shop/cart.py",
    lines: [1, 2],
    failureCase: "It breaks.",
    category: "logic",
    introduced: true,
    reportedBy: "codex-x",
    verdict,
    evidence: "",
    runId,
    round: 1,
    groupId: null,
    origin: "reviewer",
  });
}

describe("the clean stop", () => {
  it("waits while a confirmed finding above nit is still unfixed", async () => {
    const { ctx } = await makeRun();
    ctx.state.round = 3;
    ctx.eng.cleanRounds = 1;
    ctx.findings.push(finding("F-0001", "confirmed", ctx.state.id));
    expect(await endRound(ctx)).toBeNull();
    expect(ctx.eng.cleanRounds).toBe(2);
  });

  it("waits while a finding is still pending", async () => {
    const { ctx } = await makeRun();
    ctx.state.round = 3;
    ctx.eng.cleanRounds = 1;
    ctx.findings.push(finding("F-0001", "pending", ctx.state.id));
    expect(await endRound(ctx)).toBeNull();
  });

  it("stops clean once nothing is open", async () => {
    const { ctx } = await makeRun();
    ctx.state.round = 3;
    ctx.eng.cleanRounds = 1;
    ctx.findings.push(finding("F-0001", "fixed", ctx.state.id));
    expect(await endRound(ctx)).toBe("clean");
  });
});

describe("an oscillation in the last round", () => {
  it("asks a person instead of finishing at the round cap", async () => {
    const { ctx } = await makeRun({ request: { roundCap: 2 } });
    ctx.state.round = 2;
    ctx.state.stage = "sweep";
    ctx.eng.roundOpen = true;
    ctx.findings.push(
      finding("F-0001", "fixed", ctx.state.id),
      finding("F-0002", "disproved", ctx.state.id),
    );
    await ctx.store.writeJson(ctx.store.roundFile(2, "sweep"), {
      round: 2,
      created: [],
      duplicates: [],
      known: [],
      oscillations: [{ fixedId: "F-0001", returnedId: "F-0002" }],
      overlapRate: 0,
      raisedByVendor: {},
    });
    await expect(drivePrePush(ctx)).rejects.toBeInstanceOf(DecisionNeeded);
    expect(ctx.state.status).not.toBe("finished");
    expect(ctx.state.stage).toBe("find");
  });
});
