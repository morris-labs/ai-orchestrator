import { describe, expect, it } from "vitest";
import {
  BoxSchema,
  GlobalSettingsSchema,
  ProjectSchema,
  SecretRefSchema,
  SshRemoteSchema,
  boxWorkDir,
  projectContainerName,
} from "../src/index.js";
import { box, minimalBox, project, settings, sshRemote } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

describe("records", () => {
  it("round-trips a project", () => {
    expect(roundTrip(ProjectSchema, project)).toEqual(project);
  });

  it("round-trips a fully populated box", () => {
    expect(roundTrip(BoxSchema, box)).toEqual(box);
  });

  it("fills a minimal box with the 3.3.5 defaults", () => {
    const parsed = roundTrip(BoxSchema, minimalBox);
    expect(parsed).toMatchObject({
      sessionUuid: null,
      platform: "claude",
      skipPermissions: true,
      wasRunning: false,
      sshRemoteRefs: [],
      reviewState: { state: "idle" },
    });
    expect(parsed.model).toBeUndefined();
    expect(parsed.container).toBeUndefined();
  });

  it("rejects a box id without the container prefix", () => {
    expect(BoxSchema.safeParse({ ...minimalBox, id: "example" }).success).toBe(false);
  });

  it("requires a run id when a box is under review", () => {
    expect(BoxSchema.safeParse({ ...box, reviewState: { state: "under_review" } }).success).toBe(
      false,
    );
  });

  it("round-trips an SSH remote", () => {
    expect(roundTrip(SshRemoteSchema, sshRemote)).toEqual(sshRemote);
  });

  it("round-trips global settings", () => {
    const parsed = roundTrip(GlobalSettingsSchema, settings);
    expect(parsed.ceilings.copilot).toEqual({ kind: "spend", period: "month", maxUsd: 50 });
    expect(parsed.ceilings.claude).toEqual({ kind: "utilization", window: "5h", max: 0.6 });
    expect(parsed.notifications).toEqual({
      decisionNeeded: true,
      runFinished: true,
      boxEnded: true,
      roundSummary: false,
    });
  });

  it("accepts only op:// secret references and valid variable names", () => {
    expect(SecretRefSchema.safeParse({ name: "TOKEN", ref: "op://Vault/Item/field" }).success).toBe(
      true,
    );
    expect(SecretRefSchema.safeParse({ name: "TOKEN", ref: "env:TOKEN" }).success).toBe(false);
    expect(SecretRefSchema.safeParse({ name: "TOKEN", ref: "op://Vault/Item" }).success).toBe(
      false,
    );
    expect(SecretRefSchema.safeParse({ name: "1TOKEN", ref: "op://V/I/f" }).success).toBe(false);
  });

  it("derives the shared container name and the working directory", () => {
    expect(projectContainerName(project.id)).toBe("claude-agent-proj-example-app-1a2b3c4d");
    expect(boxWorkDir(BoxSchema.parse(box))).toBe(box.worktree);
    expect(boxWorkDir(BoxSchema.parse(minimalBox))).toBe(minimalBox.targetDir);
  });
});
