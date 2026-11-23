// The `aio-build` command, over a real build socket with a fake build manager.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_SOCKET_ROUTES } from "@aio/contracts";
import { EngineError } from "../../src/api/core-interface.js";
import { BUILD_USAGE, buildMain } from "../../src/build-socket/cli.js";
import { serveBuildSocket, type BuildSocketServer } from "../../src/build-socket/server.js";
import { silentLogger } from "../../src/main/logger.js";
import { buildState, fakeBuildManager } from "../api/fixtures.js";
import { tempDir } from "../tmp.js";
import { PLAN } from "./helpers.js";

let server: BuildSocketServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function world(projectId = "proj-1") {
  const dir = tempDir("aio-bcli-");
  const socket = join(dir, "build.sock");
  const builds = fakeBuildManager();
  server = await serveBuildSocket({ path: socket, builds, projectId, log: silentLogger });
  const planFile = join(dir, "plan.json");
  writeFileSync(planFile, JSON.stringify(PLAN));
  const env: Record<string, string | undefined> = {
    AIO_BUILD_SOCKET: socket,
    AIO_PROJECT_ID: "proj-1",
    AIO_BOX_ID: "box-1",
  };
  const run = async (argv: string[], over: Record<string, string | undefined> = {}) => {
    let stdout = "";
    let stderr = "";
    const code = await buildMain(argv, {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      env: { ...env, ...over },
    });
    return { code, stdout, stderr };
  };
  return { builds, planFile, run, dir, socket };
}

describe("aio-build", () => {
  it("starts a build from a plan file and prints its state", async () => {
    const { builds, planFile, run } = await world();
    const out = await run(["start", "cart-total", planFile, "--base", "main"]);
    expect(out.code).toBe(0);
    expect(builds.start).toHaveBeenCalledWith({
      projectId: "proj-1",
      boxId: "box-1",
      slug: "cart-total",
      plan: expect.objectContaining({ title: "Add a total to the cart" }),
      base: "main",
    });
    expect(out.stdout).toContain("Build cart-total: running, step tasks");
    expect(out.stdout).toContain("T1");
    expect(out.stdout).toContain(".aio/builds/cart-total/STATUS.md");
  });

  it("prints the build state as JSON with --json", async () => {
    const { planFile, run } = await world();
    const out = await run(["start", "cart-total", planFile, "--json"]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(buildState);
  });

  it("reads, pauses, and resumes a build", async () => {
    const { builds, run } = await world();
    expect((await run(["status", "cart-total"])).stdout).toContain("running");
    const paused = await run(["pause", "cart-total"]);
    expect(paused.code).toBe(0);
    expect(paused.stdout).toContain("Build cart-total: paused");
    expect(builds.pause).toHaveBeenCalledWith("cart-total", "owner");
    expect((await run(["resume", "cart-total"])).code).toBe(0);
    expect(builds.resume).toHaveBeenCalledWith("cart-total", "owner");
  });

  it("cancels a build and points to its closing record", async () => {
    const { builds, run } = await world();
    builds.cancel.mockResolvedValue({
      ...buildState,
      status: "cancelled",
      closingRecord: "closing-record.md",
    });
    const out = await run(["cancel", "cart-total"]);
    expect(out.code).toBe(0);
    expect(builds.cancel).toHaveBeenCalledWith("cart-total");
    expect(out.stdout).toContain("Build cart-total: cancelled");
    expect(out.stdout).toContain(".aio/builds/cart-total/closing-record.md");
  });

  it("refuses to control another box's build with the refusal's exit status", async () => {
    const { builds, run } = await world();
    builds.get.mockResolvedValue({ ...buildState, boxId: "box-2" });
    const out = await run(["cancel", "cart-total"]);
    expect(out.code).toBe(5);
    expect(out.stderr).toContain("box-2");
    expect(builds.cancel).not.toHaveBeenCalled();
  });

  it("sends a null box outside a box session", async () => {
    const { builds, planFile, run } = await world();
    expect((await run(["start", "cart-total", planFile], { AIO_BOX_ID: undefined })).code).toBe(0);
    expect(builds.start.mock.calls[0]![0]).not.toHaveProperty("boxId");
  });

  it("refuses to run without the project ID", async () => {
    const { builds, run } = await world();
    const out = await run(["status", "cart-total"], { AIO_PROJECT_ID: undefined });
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("AIO_PROJECT_ID");
    expect(builds.get).not.toHaveBeenCalled();
  });

  it("can't reach another project's builds", async () => {
    const { builds, run } = await world("proj-1");
    const out = await run(["pause", "cart-total"], { AIO_PROJECT_ID: "proj-2" });
    expect(out.code).toBe(4);
    expect(out.stderr).toContain("has no build cart-total");
    expect(builds.pause).not.toHaveBeenCalled();
  });

  it("explains a plan the engine refuses", async () => {
    const { planFile, run } = await world();
    writeFileSync(planFile, JSON.stringify({ ...PLAN, tasks: [] }));
    const out = await run(["start", "cart-total", planFile]);
    expect(out.code).toBe(5);
    expect(out.stderr).toMatch(/plan\.tasks/);
  });

  it("reports a conflict and an unknown build with their own exit statuses", async () => {
    const { builds, planFile, run } = await world();
    builds.start.mockRejectedValueOnce(new EngineError("conflict", "A build named x exists."));
    const conflict = await run(["start", "cart-total", planFile]);
    expect(conflict).toMatchObject({ code: 5, stderr: "aio-build: A build named x exists.\n" });
    expect((await run(["status", "no-such-build"])).code).toBe(4);
  });

  it("reports an unreadable plan file and an unreachable socket", async () => {
    const { dir, run } = await world();
    const missing = await run(["start", "cart-total", join(dir, "nope.json")]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("nope.json");
    writeFileSync(join(dir, "bad.json"), "{");
    expect((await run(["start", "cart-total", join(dir, "bad.json")])).code).toBe(2);
    const down = await run(["status", "cart-total"], { AIO_BUILD_SOCKET: join(dir, "none.sock") });
    expect(down.code).toBe(3);
    expect(down.stderr).toContain("build socket");
  });

  it.each([
    [[]],
    [["start", "cart-total"]],
    [["start", "Bad Slug", "plan.json"]],
    [["status"]],
    [["status", "a", "b"]],
    [["pause", "cart-total", "--base", "main"]],
    [["frobnicate"]],
  ])("refuses the usage %j", async (argv) => {
    const { run } = await world();
    const out = await run(argv);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("Usage:");
  });

  it("documents each request in its help", async () => {
    const { run } = await world();
    const out = await run(["--help"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(BUILD_USAGE);
    for (const kind of Object.keys(BUILD_SOCKET_ROUTES)) {
      expect(BUILD_USAGE).toMatch(new RegExp(`^  ${kind}\\b`, "m"));
    }
    for (const fact of [
      "PLAN_FILE",
      "--base",
      "--json",
      "AIO_PROJECT_ID",
      "AIO_BOX_ID",
      "Exit status",
    ]) {
      expect(BUILD_USAGE).toContain(fact);
    }
  });
});
