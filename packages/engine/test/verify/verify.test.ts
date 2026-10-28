import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoleAssignment } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import type { VerifyOutput } from "../../src/core.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { chooseDisprover, decideVerdict, runReproScript } from "../../src/verify/verify.js";

const roles: RoleAssignment = {
  reviewer: ["codex", "copilot"],
  disprover: "codex",
  confirmer: "codex",
  fixer: "claude",
};
const all = ["claude", "codex", "copilot"] as const;

function out(extra: Partial<VerifyOutput> = {}): VerifyOutput {
  return {
    verdict: "confirmed",
    verification: "script",
    evidence: "ran it",
    presentAtBase: false,
    script: null,
    ...extra,
  };
}

describe("chooseDisprover", () => {
  it("never picks the reporter with cross-vendor checks", () => {
    expect(
      chooseDisprover("copilot", roles, { crossVendor: true, available: all, profile: "offload" }),
    ).toBe("codex");
    expect(
      chooseDisprover("codex", roles, { crossVendor: true, available: all, profile: "offload" }),
    ).toBe("copilot");
    expect(
      chooseDisprover("codex", roles, {
        crossVendor: true,
        available: ["claude", "codex"],
        profile: "offload",
      }),
    ).toBe("claude");
    expect(
      chooseDisprover(
        "codex",
        { ...roles, disprover: "claude" },
        { crossVendor: true, available: all, profile: "fast" },
      ),
    ).toBe("claude");
    expect(
      chooseDisprover(null, roles, { crossVendor: true, available: all, profile: "offload" }),
    ).toBe("codex");
  });

  it("uses the reporter's vendor without cross-vendor checks", () => {
    expect(
      chooseDisprover("copilot", roles, { crossVendor: false, available: all, profile: "offload" }),
    ).toBe("copilot");
  });
});

describe("decideVerdict", () => {
  const run = (exitCode: number) => ({ exitCode, timedOut: false, output: "" });

  it("keeps a disproof", () => {
    expect(decideVerdict(out({ verdict: "disproved" }), null, null).verdict).toBe("disproved");
  });

  it("confirms by script when the engine's rerun reproduces at the tip only", () => {
    const d = decideVerdict(out({ script: { path: "r.py" } }), run(1), run(0));
    expect(d).toMatchObject({ verdict: "confirmed", verification: "script", introduced: true });
  });

  it("marks a flaw that reproduces at the base as pre-existing", () => {
    expect(decideVerdict(out({ script: { path: "r.py" } }), run(1), run(1))).toMatchObject({
      verdict: "pre-existing",
      introduced: false,
    });
    expect(
      decideVerdict(out({ verification: "code-reading", presentAtBase: true }), null, null).verdict,
    ).toBe("pre-existing");
  });

  it("falls back to code reading when the script doesn't reproduce", () => {
    const d = decideVerdict(out({ script: { path: "r.py" } }), run(0), null);
    expect(d).toMatchObject({ verdict: "confirmed", verification: "code-reading" });
    expect(d.evidence).toContain("didn't reproduce");
  });
});

describe("runReproScript", () => {
  it("runs a script against a directory and refuses one outside the scratch directory", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agentbox-scratch-"));
    writeFileSync(join(scratch, "r.sh"), 'test -f "$1/marker" && exit 1; exit 0\n');
    const repo = mkdtempSync(join(tmpdir(), "agentbox-repo-"));
    const runner = new ExecaRunner();
    expect(
      (await runReproScript(runner, scratch, { path: "r.sh", interpreter: "sh" }, repo)).exitCode,
    ).toBe(0);
    writeFileSync(join(repo, "marker"), "");
    expect(
      (await runReproScript(runner, scratch, { path: "r.sh", interpreter: "sh" }, repo)).exitCode,
    ).toBe(1);
    await expect(runReproScript(runner, scratch, { path: "../evil.sh" }, repo)).rejects.toThrow(
      /outside/,
    );
  });
});
