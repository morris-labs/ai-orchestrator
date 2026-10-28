import { describe, expect, it } from "vitest";
import { ApiCallError, createApiClient, toSearch } from "../src/lib/api.js";
import { MockError, createMockServer } from "./helpers/mockServer.js";
import { RUN_ID, lastRun } from "./helpers/data.js";

describe("toSearch", () => {
  it.each([
    [undefined, ""],
    [{}, ""],
    [{ a: "1", b: undefined, c: true }, "?a=1&c=true"],
  ])("%j", (q, want) => {
    expect(toSearch(q as Record<string, unknown> | undefined)).toBe(want);
  });
});

describe("createApiClient", () => {
  it("fills the path, sends the token, and parses the response", async () => {
    const server = createMockServer({ "runs.get": () => lastRun() });
    const api = createApiClient({ token: "secret", fetch: server.fetch });
    const run = await api.call("runs.get", { params: { runId: RUN_ID } });
    expect(run.status).toBe("waiting_decision");
    const [call] = server.calls;
    expect(call!.path).toBe(`/api/v1/runs/${RUN_ID}`);
    expect(call!.headers.authorization).toBe("Bearer secret");
  });

  it("sends the query and a validated body", async () => {
    const server = createMockServer({ "findings.waive": (c) => ({ ...lastRun(), body: c.body }) });
    const api = createApiClient({ fetch: server.fetch });
    await expect(
      api.call("findings.waive", {
        params: { runId: RUN_ID, findingId: "F-0001" },
        body: { reason: "" },
      }),
    ).rejects.toThrow();
    expect(server.calls).toHaveLength(0);
  });

  it("maps an API error body to ApiCallError", async () => {
    const server = createMockServer({
      "runs.create": () => {
        throw new MockError(409, "dirty_tree", "The working tree has uncommitted changes.");
      },
    });
    const api = createApiClient({ fetch: server.fetch });
    const err = await api
      .call("runs.create", { body: { projectId: "p", repoPath: "/r" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect((err as ApiCallError).code).toBe("dirty_tree");
    expect((err as ApiCallError).status).toBe(409);
  });

  it("rejects a response that breaks the contract", async () => {
    const server = createMockServer({ "runs.get": () => ({ id: "nope" }) });
    const api = createApiClient({ fetch: server.fetch });
    await expect(api.call("runs.get", { params: { runId: RUN_ID } })).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("reports a network failure", async () => {
    const api = createApiClient({
      fetch: (() => Promise.reject(new TypeError("refused"))) as typeof fetch,
    });
    await expect(api.call("health")).rejects.toMatchObject({ code: "network" });
  });
});
