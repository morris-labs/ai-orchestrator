// Issue #48: a Codex box takes a model and an effort, as a Claude box does,
// and its session starts `codex` with them.
import { describe, expect, it } from "vitest";
import { START_SESSION_PATH } from "../../src/docker/scripts.js";
import { makeHarness, type Harness } from "./harness.js";

/** The command of the last session start. */
function lastCommand(h: Harness): string {
  const starts = h.docker
    .callsOf("exec")
    .map((c) => (c.args[1] as { cmd: string[] }).cmd)
    .filter((cmd) => cmd[0] === START_SESSION_PATH);
  return starts.at(-1)?.[3] ?? "";
}

describe("Codex model and effort", () => {
  it("starts a new Codex box with the chosen model and effort", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      platform: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
    });
    expect(box).toMatchObject({ platform: "codex", model: "gpt-6.1-sol", effort: "high" });
    const command = lastCommand(h);
    expect(command).toContain(`'--model' 'gpt-6.1-sol'`);
    expect(command).toContain(`'-c' 'model_reasoning_effort="high"'`);
  });

  it("starts a Codex box with the model and effort saved by an edit", async () => {
    const h = makeHarness();
    const created = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      platform: "codex",
    });
    await h.core.boxes.stop(created.id);
    const { box } = await h.core.boxes.update(created.id, {
      model: "gpt-6.1-terra",
      effort: "medium",
    });
    expect(box).toMatchObject({ model: "gpt-6.1-terra", effort: "medium" });
    await h.core.boxes.start(created.id);
    const command = lastCommand(h);
    expect(command).toMatch(/ codex /);
    expect(command).toContain(`'--model' 'gpt-6.1-terra'`);
    expect(command).toContain(`'-c' 'model_reasoning_effort="medium"'`);
  });
  it("passes a Copilot box's model and reasoning effort when resuming the session", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      platform: "copilot",
      model: "gpt-5.5",
      effort: "high",
    });
    expect(lastCommand(h)).toContain("'--model' 'gpt-5.5' '--reasoning-effort' 'high'");
    await h.core.boxes.stop(box.id);
    await h.core.boxes.start(box.id);
    const command = lastCommand(h);
    expect(command).toContain("'--continue'");
    expect(command).toContain("'--model' 'gpt-5.5' '--reasoning-effort' 'high'");
  });
});
