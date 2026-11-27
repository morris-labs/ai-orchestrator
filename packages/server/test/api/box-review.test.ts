// A box starts a review run of its own branch through the secrets broker,
// and reads the run's result there. The broker serves the real box review
// over the API harness's fake core and engine.
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BROKER_ROUTES, projectContainerName, type RunState } from "@aio/contracts";
import { createBoxReview } from "../../src/api/box-review.js";
import { HOLD_EDITS_MESSAGE } from "../../src/api/handlers.js";
import { SecretsBroker } from "../../src/secrets/broker.js";
import { tempDir } from "../tmp.js";
import { createHarness, type FakeEngine, type Harness } from "./harness.js";
import { CONTAINER, PROJECT_ID, box, runState, viewOf } from "./fixtures.js";

const OTHER_PROJECT = "other-app-5e6f7a8b";

function request(
  socketPath: string,
  method: string,
  route: string,
  body?: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test reads its own response shape
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path: route,
        headers: data ? { "content-type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const brokers: SecretsBroker[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.closeAll();
  for (const h of harnesses.splice(0)) await h.server.close();
});

/** The harness, with a broker socket for the project's container that serves box reviews. */
async function setup() {
  const h = await createHarness();
  harnesses.push(h);
  // A box of another project, which this project's container must not reach.
  const foreign = {
    ...box,
    id: "aio-agent-billing",
    projectId: OTHER_PROJECT,
    branch: "claude/billing",
    container: projectContainerName(OTHER_PROJECT),
  };
  h.core.views.set(foreign.id, viewOf(foreign));
  const root = tempDir("aio-box-review-");
  const log: string[] = [];
  const broker = new SecretsBroker({
    source: { names: async () => [], read: async () => ({}) },
    review: createBoxReview(h.deps),
    dirFor: (container) => path.join(root, container),
    log: (m) => log.push(m),
  });
  brokers.push(broker);
  await broker.open({ container: CONTAINER, projectId: PROJECT_ID });
  return { h, socket: broker.socketPath(CONTAINER), log, foreign };
}

function created(engine: FakeEngine) {
  return engine.calls.filter((c) => c.key === "engine.runs.create");
}

describe("box review through the broker", () => {
  it("starts a run of the box's own branch in its own project", async () => {
    const { h, socket, log } = await setup();
    const res = await request(socket, "POST", BROKER_ROUTES.reviewStart, {
      boxId: box.id,
      base: "origin/main",
    });
    expect(res.status).toBe(201);
    const run = res.json as RunState;
    expect(run.status).toBe("pending");
    const calls = created(h.engine);
    expect(calls).toHaveLength(1);
    const body = calls[0]!.input.body as Record<string, unknown>;
    expect(body).toMatchObject({
      projectId: PROJECT_ID,
      boxId: box.id,
      repoPath: box.worktree,
      tip: box.branch,
      base: "origin/main",
      readOnly: false,
    });
    expect(body.runId).toBe(run.id);
    // The run is mirrored, and the box's session gets the hold-edits message.
    expect(h.runs.get(run.id)?.id).toBe(run.id);
    await h.deps.sessionMessages.idle?.();
    expect(h.core.calls).toContain(`deliver:${box.id}:${HOLD_EDITS_MESSAGE.slice(0, 20)}`);
    expect(log.some((l) => l.includes("review start") && l.includes(box.id))).toBe(true);
  });

  it("names the branch explicitly when it is the box's own", async () => {
    const { h, socket } = await setup();
    const res = await request(socket, "POST", BROKER_ROUTES.reviewStart, {
      boxId: box.id,
      branch: box.branch,
      readOnly: true,
      depth: "thorough",
    });
    expect(res.status).toBe(201);
    expect(created(h.engine)[0]!.input.body).toMatchObject({
      tip: box.branch,
      readOnly: true,
      depth: "thorough",
    });
  });

  it("refuses another branch", async () => {
    const { h, socket } = await setup();
    const res = await request(socket, "POST", BROKER_ROUTES.reviewStart, {
      boxId: box.id,
      branch: "main",
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation");
    expect(res.json.error.message).toContain(box.branch);
    expect(created(h.engine)).toHaveLength(0);
  });

  it("refuses a box of another project, without saying it exists", async () => {
    const { h, socket, foreign } = await setup();
    const res = await request(socket, "POST", BROKER_ROUTES.reviewStart, { boxId: foreign.id });
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("not_found");
    expect(res.json.error.message).not.toContain(OTHER_PROJECT);
    expect(created(h.engine)).toHaveLength(0);
  });

  it("refuses an unknown box and a malformed request", async () => {
    const { h, socket } = await setup();
    const unknown = await request(socket, "POST", BROKER_ROUTES.reviewStart, {
      boxId: "aio-agent-nobody",
    });
    expect(unknown.json.error.code).toBe("not_found");
    const extra = await request(socket, "POST", BROKER_ROUTES.reviewStart, {
      boxId: box.id,
      projectId: OTHER_PROJECT,
    });
    expect(extra.status).toBe(400);
    expect(extra.json.error.code).toBe("validation");
    expect(created(h.engine)).toHaveLength(0);
  });

  it("returns the box's run with its findings", async () => {
    const { socket } = await setup();
    const res = await request(
      socket,
      "GET",
      `${BROKER_ROUTES.reviewRuns}/${runState.id}?boxId=${box.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.json.run.id).toBe(runState.id);
    expect(res.json.findings).toHaveLength(1);
    expect(res.json.findings[0].id).toBe("F-0001");
  });

  it("refuses the run of another box or another project", async () => {
    const { h, socket, foreign } = await setup();
    const otherBox = await request(
      socket,
      "GET",
      `${BROKER_ROUTES.reviewRuns}/${runState.id}?boxId=${foreign.id}`,
    );
    expect(otherBox.json.error.code).toBe("not_found");
    // The project's engine answers with a run that belongs to another project.
    h.engine.handlers["engine.runs.get"] = () => ({ ...runState, projectId: OTHER_PROJECT });
    const otherProject = await request(
      socket,
      "GET",
      `${BROKER_ROUTES.reviewRuns}/${runState.id}?boxId=${box.id}`,
    );
    expect(otherProject.status).toBe(404);
    expect(otherProject.json.error.code).toBe("run_not_found");
    const unknown = await request(
      socket,
      "GET",
      `${BROKER_ROUTES.reviewRuns}/01JB8Z5K3W6Q2V9X4T7R0M1N2Z?boxId=${box.id}`,
    );
    expect(unknown.json.error.code).toBe("run_not_found");
  });

  it("answers no review routes on a broker without a review source", async () => {
    const root = tempDir("aio-box-review-");
    const broker = new SecretsBroker({
      source: { names: async () => [], read: async () => ({}) },
      dirFor: (container) => path.join(root, container),
      log: () => undefined,
    });
    brokers.push(broker);
    await broker.open({ container: CONTAINER, projectId: PROJECT_ID });
    const res = await request(broker.socketPath(CONTAINER), "POST", BROKER_ROUTES.reviewStart, {
      boxId: box.id,
    });
    expect(res.status).toBe(404);
  });
});
