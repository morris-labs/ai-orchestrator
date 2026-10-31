import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectSchema, ProjectSummarySchema } from "@agentbox/contracts";
import {
  defaultProjectName,
  detectPrimaryRepo,
  normalizeRoot,
  projectIdForRoot,
  projectSlug,
} from "../../src/projects/ids.js";
import { freeLoopbackPort, loopbackPortFree } from "../../src/projects/service.js";
import { ROOT_SETUP_SCRIPT, SUDOERS_FILE } from "../../src/docker/scripts.js";
import { engineTokenFile, readMountsFile } from "../../src/docker/state.js";
import type { ExecOptions } from "../../src/docker/types.js";
import { containerHome } from "../../src/records/env.js";
import { ApiError } from "../../src/records/errors.js";
import { sha512Crypt } from "../../src/secrets/crypt.js";
import { ENGINE_VERSION, assertContractEvent, makeHarness } from "../boxes/harness.js";

describe("project ids", () => {
  it("normalizes like QDir::cleanPath", () => {
    expect(normalizeRoot(" /work//app/ ")).toBe("/work/app");
    expect(normalizeRoot("/work/./x/../app")).toBe("/work/app");
    expect(normalizeRoot("/")).toBe("/");
    expect(normalizeRoot("  ")).toBe("");
  });

  it("derives the 3.3.5 id: slug of the folder plus sha1 of the root", () => {
    // sha1("/home/dev/My Project.v2") computed independently.
    expect(projectIdForRoot("/home/dev/My Project.v2/")).toMatch(/^My-Project-v2-[0-9a-f]{8}$/);
    expect(projectIdForRoot("/home/dev/app")).toBe(projectIdForRoot("/home/dev/app/"));
    expect(projectIdForRoot("/home/dev/app")).not.toBe(projectIdForRoot("/home/dev/app2"));
    expect(projectIdForRoot("/home/dev/...")).toMatch(/^project-[0-9a-f]{8}$/);
    expect(projectSlug("foo.bar_baz--qux-")).toBe("foo-bar-baz-qux");
    expect(projectIdForRoot("")).toBe("");
    expect(defaultProjectName("/home/dev/app")).toBe("app");
    expect(defaultProjectName("/")).toBe("/");
  });

  it("matches a known sha1", () => {
    // printf '%s' /tmp/app | sha1sum -> first 8 hex digits.
    expect(projectIdForRoot("/tmp/app")).toBe("app-bfdd05f6");
  });

  it("detects a primary repository by its .git entry", () => {
    const h = makeHarness();
    const dir = h.dir("repo");
    expect(detectPrimaryRepo(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere\n");
    expect(detectPrimaryRepo(dir)).toBe(dir);
  });
});

describe("ProjectService", () => {
  it("creates projects implicitly and explicitly", () => {
    const h = makeHarness();
    const dir = h.dir("work", "app");
    const p = h.core.projects.ensureForRoot(`${dir}/`);
    expect(ProjectSchema.parse(p)).toEqual(p);
    expect(p).toMatchObject({
      root: dir,
      name: "app",
      tcpMaps: [],
      mounts: [],
      secretRefs: [],
      policyPath: ".claude-box/policy.yaml",
    });
    expect(h.core.projects.ensureForRoot(dir).id).toBe(p.id);
    expect(() => h.core.projects.create({ root: dir })).toThrow(/already a project/);
    expect(() => h.core.projects.create({ root: path.join(dir, "missing") })).toThrow(
      /not a directory/,
    );
    const other = h.core.projects.create({ root: h.dir("work", "other"), name: "Other" });
    expect(other.name).toBe("Other");
    expect(h.core.projects.policyFile(other)).toBe(
      path.join(other.root, ".claude-box/policy.yaml"),
    );
    expect(() => h.core.projects.get("nope-00000000")).toThrow(ApiError);
  });

  it("validates updates", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    await expect(
      h.core.projects.update(p.id, { tcpMaps: [{ host: 9000, container: 20411 }] }),
    ).rejects.toThrow(/engine/);
    await expect(
      h.core.projects.update(p.id, {
        tcpMaps: [
          { host: 9000, container: 3000 },
          { host: 9000, container: 3001 },
        ],
      }),
    ).rejects.toThrow(/repeats/);
    await expect(
      h.core.projects.update(p.id, {
        mounts: [{ host: path.join(h.home, "nope"), container: "/x" }],
      }),
    ).rejects.toThrow(/do not exist/);
    const ref = { name: "TOKEN", ref: "op://V/I/f" };
    await expect(h.core.projects.update(p.id, { secretRefs: [ref, ref] })).rejects.toThrow(/twice/);
    const r = await h.core.projects.update(p.id, {
      name: "",
      tcpMaps: [{ host: 9000, container: 3000 }],
      mounts: [{ host: h.home, container: "/h" }],
      secretRefs: [ref],
      ceilingsOverride: { claude: { kind: "utilization", window: "5h", max: 0.4 } },
      policyPath: "/etc/policy.yaml",
    });
    expect(r.staleBoxes).toEqual([]);
    expect(r.project).toMatchObject({ name: "app", policyPath: "/etc/policy.yaml" });
    expect(h.core.projects.policyFile(r.project)).toBe("/etc/policy.yaml");
    const cleared = await h.core.projects.update(p.id, {
      ceilingsOverride: null,
      primaryRepo: null,
    });
    expect(cleared.project.ceilingsOverride).toBeUndefined();
  });

  it("creates the container once, registers the engine, and reuses it", async () => {
    const h = makeHarness();
    const created = h.core.projects.ensureForRoot(h.dir("app"));
    const { project: p } = await h.core.projects.update(created.id, {
      secretRefs: [{ name: "SECRET", ref: "op://V/I/f" }],
    });
    const prepared: string[][] = [];
    h.core.setHooks({
      prepareSecrets: async (projectId, container) => {
        prepared.push([projectId, container]);
        return ["SECRET"];
      },
    });
    const r = await h.core.projects.ensureContainer(p.id);
    expect(prepared).toEqual([[p.id, `claude-agent-proj-${p.id}`]]);
    expect(r).toEqual({ container: `claude-agent-proj-${p.id}`, created: true, stale: [] });
    const endpoint = h.core.projects.engineEndpoint(p.id)!;
    expect(endpoint).toMatchObject({ hostPort: 41000, container: r.container });
    expect(endpoint.token).toMatch(/^[0-9a-f]{64}$/);
    const c = h.docker.containers.get(r.container)!;
    expect(c.spec.env.join("\n")).not.toContain(endpoint.token);
    const tokenFile = engineTokenFile(h.env, r.container);
    expect(fs.readFileSync(tokenFile, "utf8")).toBe(`${endpoint.token}\n`);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(c.spec.env.some((e) => e.startsWith("SECRET="))).toBe(false);
    expect(c.spec.labels["agentbox.secret-names"]).toBe("SECRET");
    expect(c.spec.env).toContain(`AGENTBOX_ENGINE_VERSION=${ENGINE_VERSION}`);
    expect(readMountsFile(h.env, r.container)).toEqual([]);
    const again = await h.core.projects.ensureContainer(p.id);
    expect(again.created).toBe(false);
    expect(h.docker.callsOf("createContainer")).toHaveLength(1);
    const changed = h.events.filter((e) => e.type === "container.changed");
    expect(changed).toHaveLength(1);
    assertContractEvent(changed[0]!);
    const summary = await h.core.projects.summary(p);
    expect(ProjectSummarySchema.parse(summary)).toMatchObject({
      running: 0,
      total: 0,
      container: { state: "running", engine: { hostPort: 41000 } },
    });
  });

  it("runs the root setup step as root, without sudo, and turns sudo off by default", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    const r = await h.core.projects.ensureContainer(p.id);
    const execs = h.docker.callsOf("exec");
    expect(execs).toHaveLength(1);
    const [, options] = execs[0]!.args as [string, ExecOptions];
    expect(options.user).toBe("root");
    expect(options.cmd.slice(0, 3)).toEqual(["/bin/sh", "-c", ROOT_SETUP_SCRIPT]);
    expect(options.cmd.slice(4)).toEqual([h.env.user, containerHome(h.env), SUDOERS_FILE, p.root]);
    expect(options.stdin).toBe("\n");
    expect(h.docker.containers.get(r.container)!.spec.labels["agentbox.sudo"]).toBe("off");
  });

  it("installs the sudo password hash only through the root step's standard input", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    const hash = sha512Crypt("SYNTHETIC_PASSWORD", "SYNTHETICsalt", 1000);
    h.core.setHooks({ sudoPasswordHash: async () => hash });
    const r = await h.core.projects.ensureContainer(p.id);
    const [, options] = h.docker.callsOf("exec")[0]!.args as [string, ExecOptions];
    expect(options.stdin).toBe(`${hash}\n`);
    const c = h.docker.containers.get(r.container)!;
    expect(c.spec.labels["agentbox.sudo"]).toBe("password");
    expect(JSON.stringify(c.spec)).not.toContain(hash);
    expect(JSON.stringify(options.cmd) + JSON.stringify(options.env)).not.toContain(hash);
  });

  it("removes the container when the root setup step fails", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    h.docker.execHandler = (_c, options) =>
      options.user === "root"
        ? { exitCode: 12, stdout: "", stderr: "can't remove /etc/sudoers.d/claude-box\n" }
        : undefined;
    await expect(h.core.projects.ensureContainer(p.id)).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("can't remove /etc/sudoers.d/claude-box"),
    });
    expect(h.docker.callsOf("removeContainer")).toHaveLength(1);
    expect(h.core.projects.engineEndpoint(p.id)).toBeUndefined();
  });

  it("blocks the launch when the sudo password can't be resolved", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    h.core.setHooks({
      sudoPasswordHash: async () => {
        throw new ApiError("secrets_locked", "The 1Password CLI is not signed in.");
      },
    });
    await expect(h.core.projects.ensureContainer(p.id)).rejects.toMatchObject({
      code: "secrets_locked",
    });
    expect(h.docker.callsOf("createContainer")).toHaveLength(0);
  });

  it("reports a container whose sudo policy differs from the settings as stale", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    const r = await h.core.projects.ensureContainer(p.id);
    expect(await h.core.projects.staleDifferences(p)).toEqual([]);
    h.core.settings.patch({ sudoPasswordRef: "op://SYNTHETIC/sudo/password" });
    expect(await h.core.projects.staleDifferences(p)).toEqual(["sudo off -> password"]);
    // A container from an older server has the image's passwordless sudo.
    delete h.docker.containers.get(r.container)!.spec.labels["agentbox.sudo"];
    h.core.settings.patch({ sudoPasswordRef: null });
    expect(await h.core.projects.staleDifferences(p)).toEqual(["sudo passwordless -> off"]);
  });

  it("reports a container with secrets in its environment as stale", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    const r = await h.core.projects.ensureContainer(p.id);
    expect(await h.core.projects.staleDifferences(p)).toEqual([]);
    // A container that a server from before the broker created has no label.
    delete h.docker.containers.get(r.container)!.spec.labels["agentbox.secrets"];
    expect(await h.core.projects.staleDifferences(p)).toEqual(["secrets environment -> broker"]);
  });

  it("reports a container on an image from before a rebuild as stale", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    const r = await h.core.projects.ensureContainer(p.id);
    expect(await h.core.projects.staleDifferences(p)).toEqual([]);
    // The tag now names a rebuilt image; the container keeps the old one.
    h.docker.containers.get(r.container)!.imageId = "sha256:older";
    expect(await h.core.projects.staleDifferences(p)).toEqual(["image -> rebuilt"]);
    expect((await h.core.projects.summary(p)).container?.stale).toEqual(["image -> rebuilt"]);
    // Without image data, nothing is flagged.
    h.docker.images.clear();
    expect(await h.core.projects.staleDifferences(p)).toEqual([]);
  });

  it("flags a stale container in the project list and the project view", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    const r = await h.core.projects.ensureContainer(p.id);
    expect((await h.core.projects.summary(p)).container).not.toHaveProperty("stale");
    delete h.docker.containers.get(r.container)!.spec.labels["agentbox.secrets"];
    expect((await h.core.projects.summary(p)).container?.stale).toEqual([
      "secrets environment -> broker",
    ]);
    const listed = (await h.core.projects.summaries()).find((s) => s.project.id === p.id);
    expect(listed?.container?.stale).toEqual(["secrets environment -> broker"]);
  });

  it("blocks the launch when the pre-start check fails", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    h.core.setHooks({
      prepareSecrets: async () => {
        throw new ApiError("secrets_locked", "The 1Password CLI is not signed in.");
      },
    });
    await expect(h.core.projects.ensureContainer(p.id)).rejects.toMatchObject({
      code: "secrets_locked",
    });
    expect(h.docker.callsOf("createContainer")).toHaveLength(0);
  });

  it("refuses a missing image or a mismatched engine", async () => {
    const missing = makeHarness({ image: false });
    const p1 = missing.core.projects.ensureForRoot(missing.dir("app"));
    await expect(missing.core.projects.ensureContainer(p1.id)).rejects.toMatchObject({
      code: "image_missing",
    });
    const old = makeHarness({ engineLabel: "3.9.0" });
    const p2 = old.core.projects.ensureForRoot(old.dir("app"));
    await expect(old.core.projects.ensureContainer(p2.id)).rejects.toMatchObject({
      code: "engine_mismatch",
      details: { imageEngineVersion: "3.9.0" },
    });
  });

  it("names Claude Box 3.x for an image without an engine", async () => {
    // Claude Box 3.x builds the same tag from the old Dockerfile, which has
    // no engine and no version label.
    const h = makeHarness();
    h.docker.addImage("claude-code", {});
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    await expect(h.core.projects.ensureContainer(p.id)).rejects.toMatchObject({
      code: "engine_mismatch",
      message: expect.stringContaining("Claude Box 3.x"),
      details: { imageEngineVersion: null },
    });
    expect(h.docker.callsOf("createContainer")).toHaveLength(0);
  });

  it("reports stale mounts, maps, and secrets and replaces an idle stale container", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    await h.core.projects.ensureContainer(p.id);
    const extra = h.dir("extra");
    await h.core.projects.update(p.id, {
      mounts: [{ host: extra, container: "/extra" }],
      tcpMaps: [{ host: 9000, container: 3000 }],
    });
    const updated = h.core.projects.get(p.id);
    expect(await h.core.projects.staleDifferences(updated)).toEqual([
      `${extra}:/extra`,
      "TCP maps none -> 127.0.0.1:9000:3000",
    ]);
    // The secret list doesn't make a container stale: the broker reads it on every request.
    await h.core.projects.update(p.id, { secretRefs: [{ name: "X", ref: "op://V/I/x" }] });
    expect(await h.core.projects.staleDifferences(h.core.projects.get(p.id))).toHaveLength(2);
    const r = await h.core.projects.ensureContainer(p.id);
    expect(r.created).toBe(true);
    expect(h.docker.callsOf("stopContainer")).toHaveLength(1);
    expect(await h.core.projects.staleDifferences(h.core.projects.get(p.id))).toEqual([]);
  });

  it("refuses a relative root and mounts docker can't bind", async () => {
    const h = makeHarness();
    expect(() => h.core.projects.ensureForRoot("SYNTHETIC_relative")).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
    expect(() => h.core.projects.create({ root: "SYNTHETIC_relative" })).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    await expect(
      h.core.projects.update(p.id, { mounts: [{ host: h.dir("x"), container: "relative" }] }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(() => h.core.settings.setGlobalMounts([{ host: "relative", container: "/x" }])).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
  });

  it("waits for an exited container the daemon is still removing before creating one", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    const first = await h.core.projects.ensureContainer(p.id);
    const c = h.docker.containers.get(first.container)!;
    c.running = false;
    c.state = "exited";
    h.docker.removing.set(first.container, 2);
    const r = await h.core.projects.ensureContainer(p.id);
    expect(r.created).toBe(true);
    expect(h.docker.callsOf("createContainer")).toHaveLength(2);
    expect(h.docker.containers.get(first.container)?.running).toBe(true);
  });

  it("replaces an idle container built from an older image", async () => {
    const h = makeHarness();
    const p = h.core.projects.ensureForRoot(h.dir("app"));
    await h.core.projects.ensureContainer(p.id);
    h.docker.addImage(
      "claude-code",
      { "agentbox.engine-version": ENGINE_VERSION },
      "sha256:claude-code-2",
    );
    expect((await h.core.projects.ensureContainer(p.id)).created).toBe(true);
  });

  it("keeps the stored engine port when it is free and avoids other projects' ports", async () => {
    const h = makeHarness();
    const a = h.core.projects.ensureForRoot(h.dir("a"));
    const b = h.core.projects.ensureForRoot(h.dir("b"));
    await h.core.projects.ensureContainer(a.id);
    await h.core.projects.ensureContainer(b.id);
    expect(h.core.projects.engineEndpoint(a.id)?.hostPort).toBe(41000);
    expect(h.core.projects.engineEndpoint(b.id)?.hostPort).toBe(41001);
    await h.core.projects.stopContainer(a.id);
    const token = h.core.projects.engineEndpoint(a.id)?.token;
    await h.core.projects.ensureContainer(a.id);
    expect(h.core.projects.engineEndpoint(a.id)?.hostPort).toBe(41000);
    expect(h.core.projects.engineEndpoint(a.id)?.token).not.toBe(token);
  });
});

describe("loopback ports", () => {
  it("finds a free port and sees it free", async () => {
    const port = await freeLoopbackPort(new Set());
    expect(port).toBeGreaterThan(0);
    expect(await loopbackPortFree(port)).toBe(true);
  });
});
