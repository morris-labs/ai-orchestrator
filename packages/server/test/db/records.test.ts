// Tests for the record helpers: environment, errors, events, settings, SSH
// remotes, the keyed mutex, and derived box values.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPT_TEMPLATES, defaultConfig, type Box } from "@agentbox/contracts";
import { openDatabase, repositories } from "../../src/db/index.js";
import {
  ApiError,
  CoreEvents,
  KeyedMutex,
  SettingsService,
  SshRemoteService,
  allocateHostKey,
  boxTmuxSession,
  containerUsername,
  displayPath,
  hostToContainer,
  promptPath,
  sideSessionName,
  splitMountSpec,
  stamp,
  tmuxSessionName,
  type CoreEventPayload,
  type HostEnv,
} from "../../src/records/index.js";
import { assertContractEvent } from "../boxes/harness.js";
import { tempDir } from "../tmp.js";

function tempEnv(): HostEnv {
  const home = tempDir("agentbox-rec-");
  return { home, user: "tester", now: () => new Date("2026-10-28T09:00:00Z") };
}

describe("env", () => {
  it("picks the container user like 3.3.5", () => {
    expect(containerUsername({ USER: "dev" })).toBe("dev");
    expect(containerUsername({ LOGNAME: "first.last" })).toBe("first.last");
    expect(containerUsername({ USERNAME: "Jane Doe" })).toBe("user");
    expect(containerUsername({ USER: "a:b" })).toBe("user");
    expect(containerUsername({})).toBe("user");
  });

  it("maps host paths to container paths and prompt paths", () => {
    expect(hostToContainer("/work/app/")).toBe("/work/app");
    expect(hostToContainer("/work/./app/../app")).toBe("/work/app");
    expect(displayPath("/home/tester", "/home/tester")).toBe("~");
    expect(displayPath("/home/tester/x/y", "/home/tester")).toBe("~/x/y");
    expect(displayPath("/home/testerx", "/home/tester")).toBe("/home/testerx");
    const env = tempEnv();
    expect(promptPath({ ...env, home: "/home/tester" }, "/home/tester/work")).toBe("~/work");
  });

  it("splits mount specs and formats stamps", () => {
    expect(splitMountSpec("/a:/b")).toEqual({ host: "/a", container: "/b" });
    expect(splitMountSpec("/a")).toEqual({ host: "/a", container: "" });
    expect(stamp(new Date(2026, 9, 28, 9, 5, 7))).toBe("20261028090507");
  });
});

describe("ApiError", () => {
  it("maps codes to statuses and contract bodies", () => {
    const e = new ApiError("session_tracked", "held", { holders: ["x"] });
    expect(e.status).toBe(409);
    expect(e.toBody()).toEqual({
      error: { code: "session_tracked", message: "held", details: { holders: ["x"] } },
    });
    expect(new ApiError("not_found", "gone").status).toBe(404);
    expect(new ApiError("secrets_locked", "locked").status).toBe(503);
    expect(new ApiError("validation", "bad").toBody()).toEqual({
      error: { code: "validation", message: "bad" },
    });
  });
});

describe("CoreEvents", () => {
  it("emits each payload as event and under its type", () => {
    const events = new CoreEvents();
    const all: CoreEventPayload[] = [];
    const typed: unknown[] = [];
    const off = events.subscribe((e) => all.push(e));
    events.on("container.changed", (e) => typed.push(e));
    events.publish({
      type: "container.changed",
      container: "claude-agent-proj-x-12345678",
      projectId: "x-12345678",
      state: "running",
      engine: null,
    });
    off();
    events.publish({
      type: "container.changed",
      container: "c",
      projectId: "p",
      state: "exited",
      engine: null,
    });
    expect(all).toHaveLength(1);
    expect(typed).toHaveLength(2);
    assertContractEvent(all[0]!);
  });
});

describe("derived box values", () => {
  it("rewrites tmux names and builds side sessions", () => {
    expect(tmuxSessionName("claude-agent-app.example.com")).toBe("claude-agent-app_example_com");
    expect(tmuxSessionName("a:b")).toBe("a_b");
    expect(tmuxSessionName("")).toBe("main");
    expect(boxTmuxSession({ session: "x.y" })).toBe("x_y");
    expect(sideSessionName({ session: "x.y" }, "codex")).toBe("x_y-codex");
  });

  it("keeps host keys unique within a project", () => {
    const sib = [{ id: "claude-agent-app", hostKey: "app" }] as Pick<Box, "id" | "hostKey">[];
    expect(allocateHostKey("claude-agent-app", sib)).toBe("app");
    expect(allocateHostKey("claude-agent-App", sib)).toBe("app-2");
  });
});

describe("KeyedMutex", () => {
  it("runs calls with one key in order and other keys in parallel", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const slow = (tag: string, ms: number) => async () => {
      order.push(`${tag}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}-`);
      return tag;
    };
    const results = await Promise.all([
      m.run("a", slow("a1", 30)),
      m.run("a", slow("a2", 1)),
      m.run("b", slow("b1", 1)),
    ]);
    expect(results).toEqual(["a1", "a2", "b1"]);
    expect(order.indexOf("a2+")).toBeGreaterThan(order.indexOf("a1-"));
    expect(order.indexOf("b1+")).toBeLessThan(order.indexOf("a1-"));
    await expect(m.run("a", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await m.run("a", async () => 1)).toBe(1);
  });
});

describe("SettingsService", () => {
  function setup() {
    const env = tempEnv();
    const repos = repositories(openDatabase(":memory:"));
    const events = new CoreEvents();
    const published: CoreEventPayload[] = [];
    events.subscribe((e) => published.push(e));
    return { env, repos, settings: new SettingsService(env, repos.settings, events), published };
  }

  it("patches fields, clears with null, and publishes the changed keys", () => {
    const { settings, published } = setup();
    settings.patch({
      proxyPort: 20500,
      notifications: { roundSummary: false },
      ceilings: { codex: { kind: "utilization", window: "7d", max: 0.5 } },
    });
    const s = settings.get();
    expect(s.proxyPort).toBe(20500);
    expect(s.notifications).toEqual({
      decisionNeeded: true,
      runFinished: true,
      readyToPush: true,
      boxEnded: true,
      roundSummary: false,
    });
    expect(s.ceilings.codex).toEqual({ kind: "utilization", window: "7d", max: 0.5 });
    expect(s.ceilings.claude).toEqual(defaultConfig().ceilings.claude);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "settings.changed",
      changedKeys: ["ceilings", "notifications", "proxyPort"],
    });
    assertContractEvent(published[0]!);
    settings.patch({ proxyPort: null });
    expect(settings.get().proxyPort).toBeUndefined();
    settings.patch({ proxyPort: null });
    expect(published).toHaveLength(2);
  });

  it("patches vendor defaults per field and clears with null", () => {
    const { settings } = setup();
    expect(settings.get().vendorDefaults).toEqual({
      claude: {},
      codex: {},
      copilot: { model: "auto" },
    });
    settings.patch({
      vendorDefaults: {
        claude: { model: "claude-opus-5-5", effort: "high" },
        codex: { model: "gpt-6" },
        copilot: { model: "claude-sonnet-5" },
      },
    });
    settings.patch({ vendorDefaults: { claude: { effort: null }, codex: { model: null } } });
    expect(settings.get().vendorDefaults).toEqual({
      claude: { model: "claude-opus-5-5" },
      codex: {},
      copilot: { model: "claude-sonnet-5" },
    });
  });

  it("reads a stored settings document that predates vendor defaults", () => {
    const { repos } = setup();
    const stored = structuredClone(defaultConfig()) as Record<string, unknown>;
    delete stored.vendorDefaults;
    delete (stored.notifications as Record<string, unknown>).readyToPush;
    repos.sqlite
      .prepare("INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)")
      .run(JSON.stringify(stored), new Date().toISOString());
    const s = repos.settings.get();
    expect(s.vendorDefaults.copilot.model).toBe("auto");
    expect(s.notifications.readyToPush).toBe(true);
  });

  it("rejects server-owned fields in a patch", () => {
    const { settings } = setup();
    expect(() => settings.patch({ setupCompleted: true } as never)).toThrow(ApiError);
  });

  it("stores templates, an empty Starter included", () => {
    const { settings } = setup();
    settings.setPromptTemplates({ ...DEFAULT_PROMPT_TEMPLATES, starter: "" });
    expect(settings.get().promptTemplates.starter).toBe("");
    expect(settings.defaultPromptTemplates()).toEqual(DEFAULT_PROMPT_TEMPLATES);
  });

  it("requires existing host directories for global mounts", () => {
    const { env, settings } = setup();
    expect(() =>
      settings.setGlobalMounts([{ host: path.join(env.home, "missing"), container: "/x" }]),
    ).toThrow(/do not exist/);
    settings.setGlobalMounts([{ host: env.home, container: "/x" }]);
    expect(settings.get().globalMounts).toEqual([{ host: env.home, container: "/x" }]);
  });

  it("refuses duplicate secret names", () => {
    const { settings } = setup();
    const ref = { name: "TOKEN", ref: "op://Vault/Item/field" };
    expect(() => settings.setSecretRefs([ref, ref])).toThrow(/twice/);
    settings.setSecretRefs([ref]);
    expect(settings.get().secretRefs).toEqual([ref]);
  });

  it("refuses a secret named like a variable the server sets", () => {
    const { settings } = setup();
    for (const name of [
      "AGENTBOX_ENGINE_TOKEN",
      "AGENTBOX_ENGINE_TOKEN_FILE",
      "IS_SANDBOX",
      "GIT_CONFIG_GLOBAL",
    ]) {
      expect(() => settings.setSecretRefs([{ name, ref: "op://Vault/Item/field" }])).toThrow(
        /reserved/,
      );
    }
  });

  it("completes setup, remembers layouts, and caches models", () => {
    const { settings } = setup();
    settings.completeSetup("/work");
    expect(settings.get()).toMatchObject({ setupCompleted: true, defaultTargetDir: "/work" });
    settings.rememberLayout("/work/app", { workspace: false, worktree: true });
    expect(settings.get().newBoxDefaults).toEqual({
      workspaceDirs: { "/work/app": false },
      worktreeDirs: { "/work/app": true },
    });
    settings.setModelCache({
      imageId: "sha256:x",
      scannedAt: "2026-10-28T09:00:00Z",
      models: ["claude-opus-5-5"],
    });
    expect(settings.get().modelCache?.models).toEqual(["claude-opus-5-5"]);
  });

  it("seeds from config.json once", () => {
    const { env, repos, settings } = setup();
    fs.mkdirSync(path.join(env.home, ".claude-box"), { recursive: true });
    fs.writeFileSync(
      path.join(env.home, ".claude-box", "config.json"),
      JSON.stringify({ serverPort: 20450 }),
    );
    expect(settings.seedFromConfigFile()).toBe(true);
    expect(repos.settings.get().serverPort).toBe(20450);
    expect(settings.seedFromConfigFile()).toBe(false);
  });
});

describe("SshRemoteService", () => {
  it("renames a remote and rewrites box references, and unlinks on delete", () => {
    const env = tempEnv();
    const repos = repositories(openDatabase(":memory:"));
    const T = "2026-10-28T09:00:00.000Z";
    repos.projects.put({
      id: "app-12345678",
      root: "/work/app",
      name: "app",
      tcpMaps: [],
      mounts: [],
      secretRefs: [],
      policyPath: ".claude-box/policy.yaml",
      createdAt: T,
      updatedAt: T,
    });
    repos.boxes.put({
      id: "claude-agent-a",
      projectId: "app-12345678",
      hostKey: "a",
      targetDir: "/work/app",
      sessionUuid: null,
      conversationName: "",
      transcriptSyncedName: "",
      platform: "claude",
      skipPermissions: true,
      container: "claude-agent-proj-app-12345678",
      session: "claude-agent-a",
      wasRunning: false,
      sshRemoteRefs: ["lab"],
      createdAt: T,
      updatedAt: T,
    });
    const svc = new SshRemoteService(env, repos);
    svc.put("lab", {
      name: "lab",
      host: "dev@203.0.113.5",
      forwards: [{ direction: "L", bindPort: 8080, destHost: "localhost", destPort: 80 }],
    });
    expect(svc.get("lab")).toMatchObject({
      referencedBy: ["claude-agent-a"],
      remote: { forwards: [{ bindAddress: "localhost" }] },
    });
    svc.put("other", { name: "other", host: "dev@203.0.113.6" });
    expect(() => svc.put("lab", { name: "other", host: "x" })).toThrow(/already exists/);
    svc.put("lab", { name: "lab2", host: "dev@203.0.113.5" });
    expect(repos.boxes.get("claude-agent-a")?.sshRemoteRefs).toEqual(["lab2"]);
    expect(() => svc.get("lab")).toThrow(ApiError);
    expect(svc.delete("lab2")).toEqual({ unlinkedBoxes: ["claude-agent-a"] });
    expect(repos.boxes.get("claude-agent-a")?.sshRemoteRefs).toEqual([]);
    expect(() => svc.delete("lab2")).toThrow(/does not exist/);
    expect(svc.list().map((r) => r.remote.name)).toEqual(["other"]);
  });
});
