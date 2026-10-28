import { describe, expect, it } from "vitest";
import {
  BoxInputSchema,
  BoxSchema,
  GlobalSettingsPatchSchema,
  GlobalSettingsSchema,
  HostKeySchema,
  ProjectInputSchema,
  ProjectSchema,
  SecretRefSchema,
  SshRemoteInputSchema,
  SshRemoteSchema,
  boxWorkDir,
  deriveHostKey,
  parseConfig,
  projectContainerName,
} from "../src/index.js";
import { box, minimalBoxInput, project, settingsFile, sshRemote } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

describe("records", () => {
  it("round-trips a project", () => {
    expect(roundTrip(ProjectSchema, project)).toEqual(project);
  });

  it("defaults a project's settings only through the input schema", () => {
    const { tcpMaps: _t, mounts: _m, secretRefs: _s, policyPath: _p, ...bare } = project;
    expect(ProjectSchema.safeParse(bare).success).toBe(false);
    expect(ProjectSchema.parse(ProjectInputSchema.parse(bare))).toMatchObject({
      tcpMaps: [],
      mounts: [],
      secretRefs: [],
      policyPath: ".claude-box/policy.yaml",
    });
  });

  it("round-trips a fully populated box", () => {
    expect(roundTrip(BoxSchema, box)).toEqual(box);
  });

  it("fills a minimal box with the 3.3.5 defaults through the input schema", () => {
    expect(BoxSchema.safeParse(minimalBoxInput).success).toBe(false);
    const parsed = roundTrip(BoxSchema, BoxInputSchema.parse(minimalBoxInput));
    expect(parsed).toMatchObject({
      sessionUuid: null,
      conversationName: "",
      platform: "claude",
      skipPermissions: true,
      wasRunning: false,
      sshRemoteRefs: [],
    });
    expect(parsed.model).toBeUndefined();
  });

  it("requires a container, a session, and a host key on a box", () => {
    for (const key of ["container", "session", "hostKey"] as const) {
      const { [key]: _omitted, ...rest } = box;
      expect(BoxSchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it("does not store a review state on a box", () => {
    expect(BoxSchema.parse({ ...box, reviewState: { state: "idle" } })).not.toHaveProperty(
      "reviewState",
    );
  });

  it("rejects a box id without the container prefix", () => {
    expect(BoxSchema.safeParse({ ...box, id: "example" }).success).toBe(false);
  });

  it("round-trips an SSH remote and defaults its forwards on input", () => {
    expect(roundTrip(SshRemoteSchema, sshRemote)).toEqual(sshRemote);
    const parsed = SshRemoteInputSchema.parse({
      name: "build",
      host: "ci@build.example.com",
      forwards: [{ direction: "L", bindPort: 8080, destHost: "localhost", destPort: 80 }],
    });
    expect(parsed.forwards[0]?.bindAddress).toBe("localhost");
    expect(SshRemoteInputSchema.parse({ name: "x", host: "y" }).forwards).toEqual([]);
  });

  it("parses the configuration file into complete, strict global settings", () => {
    const parsed = roundTrip(GlobalSettingsSchema, parseConfig(settingsFile));
    expect(parsed.ceilings.copilot).toEqual({ kind: "spend", period: "month", maxUsd: 50 });
    expect(parsed.ceilings.claude).toEqual({ kind: "utilization", window: "5h", max: 0.6 });
    expect(parsed.notifications.roundSummary).toBe(false);
    expect(parsed.notifications.readyToPush).toBe(true);
    expect(parsed.vendorDefaults).toEqual({
      claude: { effort: "high" },
      codex: {},
      copilot: { model: "auto" },
    });
    expect(parsed.proxyPort).toBeUndefined();
    expect(GlobalSettingsSchema.safeParse({ ...parsed, colour: "blue" }).success).toBe(false);
    expect(GlobalSettingsSchema.safeParse(settingsFile).success).toBe(false);
  });

  it("accepts only editable fields in a settings patch", () => {
    expect(
      GlobalSettingsPatchSchema.parse({ proxyPort: null, notifications: { boxEnded: false } }),
    ).toEqual({
      proxyPort: null,
      notifications: { boxEnded: false },
    });
    for (const owned of [
      { serverPort: 20500 },
      { setupCompleted: true },
      { modelCache: null },
      { newBoxDefaults: {} },
      { promptTemplates: {} },
      { globalMounts: [] },
    ]) {
      expect(GlobalSettingsPatchSchema.safeParse(owned).success, Object.keys(owned)[0]).toBe(false);
    }
  });

  it("patches vendor defaults field by field", () => {
    expect(
      GlobalSettingsPatchSchema.parse({
        vendorDefaults: { claude: { model: null }, copilot: { model: "gpt-5" } },
      }),
    ).toEqual({ vendorDefaults: { claude: { model: null }, copilot: { model: "gpt-5" } } });
    expect(
      GlobalSettingsPatchSchema.safeParse({ vendorDefaults: { copilot: { model: null } } }).success,
    ).toBe(false);
    expect(
      GlobalSettingsPatchSchema.safeParse({ vendorDefaults: { codex: { effort: "high" } } })
        .success,
    ).toBe(false);
    expect(GlobalSettingsPatchSchema.parse({ notifications: { readyToPush: false } })).toEqual({
      notifications: { readyToPush: false },
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
    expect(boxWorkDir({ targetDir: "/t" })).toBe("/t");
  });
});

describe("deriveHostKey", () => {
  it("strips the prefix and maps to lowercase letters, digits, and hyphens", () => {
    expect(deriveHostKey("claude-agent-Emails_not_sending")).toBe("emails-not-sending");
    expect(deriveHostKey("claude-agent-a..b--c_")).toBe("a-b-c");
    expect(deriveHostKey("claude-agent-___")).toBe("box");
  });

  it("cuts to 30 characters without a trailing hyphen", () => {
    const key = deriveHostKey(`claude-agent-${"abcdefghi-".repeat(5)}`);
    expect(key.length).toBeLessThanOrEqual(30);
    expect(HostKeySchema.safeParse(key).success).toBe(true);
  });

  it("appends a counter when the key is taken", () => {
    expect(deriveHostKey("claude-agent-api", new Set(["api"]))).toBe("api-2");
    expect(deriveHostKey("claude-agent-api", new Set(["api", "api-2"]))).toBe("api-3");
    const long = "x".repeat(40);
    const taken = new Set([deriveHostKey(`claude-agent-${long}`)]);
    const next = deriveHostKey(`claude-agent-${long}`, taken);
    expect(next).toMatch(/-2$/);
    expect(next.length).toBe(30);
  });

  it("produces keys the schema accepts", () => {
    for (const id of ["claude-agent-x", "claude-agent-ABC-123", "claude-agent-émoji-ü"]) {
      expect(HostKeySchema.safeParse(deriveHostKey(id)).success, id).toBe(true);
    }
    expect(HostKeySchema.safeParse("-bad").success).toBe(false);
    expect(HostKeySchema.safeParse("a".repeat(31)).success).toBe(false);
  });
});
