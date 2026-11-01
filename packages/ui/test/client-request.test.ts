// ApiClient.request(): calls to API paths the route table doesn't list.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiClient, createMachineClient } from "../src/core";

describe("request", () => {
  it("calls a path the route table doesn't list, on the client's machine", async () => {
    const seen: { url: string; method?: string; body?: unknown }[] = [];
    const options = {
      fetch: async (u: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(u), method: init?.method, body: init?.body });
        return new Response(JSON.stringify({ n: 1 }), { status: 200 });
      },
    };
    const schema = z.object({ n: z.number() });
    const res = await new ApiClient(options).request("POST", "/api/v1/things", schema, {
      body: { a: 1 },
    });
    expect(res.n).toBe(1);
    expect(seen[0]).toEqual({ url: "/api/v1/things", method: "POST", body: '{"a":1}' });
    await createMachineClient(options, "node-a").request("GET", "/api/v1/things", schema);
    expect(seen[1]?.url).toBe("/api/v1/machines/node-a/proxy/things");
    await expect(
      new ApiClient(options).request("GET", "/api/v1/things", z.object({ n: z.string() })),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});
