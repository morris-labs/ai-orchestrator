import type { ImageStatus } from "@agentbox/contracts";
import { UpdatesSchema } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { compareVersions, UpdateChecker } from "../../src/setup/updates.js";

const imageStatus = (claude: string | null, exists = true): ImageStatus => ({
  name: "claude-code",
  exists,
  imageId: null,
  createdAt: null,
  engineVersion: null,
  expectedEngineVersion: "4.0.0",
  engineMatches: false,
  cliVersions: { claude, codex: null, copilot: null },
});

function fakeFetch(answers: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (!(url in answers)) throw new Error("offline");
    return new Response(JSON.stringify(answers[url]), { status: 200 });
  }) as typeof fetch;
}

const GH = "https://api.github.com/repos/morris-labs/Claude-Box/releases/latest";
const NPM = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";

describe("compareVersions", () => {
  it("compares numerically and orders pre-releases first", () => {
    expect(compareVersions("4.0.10", "4.0.9")).toBeGreaterThan(0);
    expect(compareVersions("v4.0.0", "4.0.0")).toBe(0);
    expect(compareVersions("4.0.0-dev", "4.0.0")).toBeLessThan(0);
    expect(compareVersions("4.0.0", "4.0.0-dev")).toBeGreaterThan(0);
    expect(compareVersions("2.1.9", "2.1.300")).toBeLessThan(0);
  });
});

describe("UpdateChecker", () => {
  it("reports available updates", async () => {
    const calls: string[] = [];
    const checker = new UpdateChecker({
      fetch: fakeFetch(
        {
          [GH]: {
            tag_name: "v4.1.0",
            html_url: "https://github.com/morris-labs/Claude-Box/releases/tag/v4.1.0",
          },
          [NPM]: { version: "2.1.301" },
        },
        calls,
      ),
      currentVersion: "4.0.0",
      image: { status: async () => imageStatus("2.1.300") },
      now: () => new Date("2026-10-28T00:00:00Z"),
    });
    const result = UpdatesSchema.parse(await checker.check(false));
    expect(result.app).toEqual({
      current: "4.0.0",
      latest: "4.1.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/morris-labs/Claude-Box/releases/tag/v4.1.0",
    });
    expect(result.claudeCode).toEqual({ image: "2.1.300", latest: "2.1.301", stale: true });
    await checker.check(false);
    expect(calls).toHaveLength(2);
    await checker.check(true);
    expect(calls).toHaveLength(4);
  });

  it("survives a network failure and a missing image", async () => {
    const checker = new UpdateChecker({
      fetch: fakeFetch({}),
      currentVersion: "4.0.0",
      image: { status: async () => imageStatus(null, false) },
    });
    const result = UpdatesSchema.parse(await checker.check(false));
    expect(result.app).toMatchObject({ latest: null, updateAvailable: false, releaseUrl: null });
    expect(result.claudeCode).toEqual({ image: null, latest: null, stale: false });
  });

  it("re-checks after the cache expires", async () => {
    const calls: string[] = [];
    let now = new Date("2026-10-28T00:00:00Z");
    const checker = new UpdateChecker({
      fetch: fakeFetch({ [NPM]: { version: "1.0.0" } }, calls),
      currentVersion: "4.0.0",
      image: { status: async () => imageStatus("1.0.0") },
      now: () => now,
      ttlMs: 1000,
    });
    await checker.check(false);
    now = new Date(now.getTime() + 2000);
    expect((await checker.check(false)).claudeCode.stale).toBe(false);
    expect(calls).toHaveLength(4);
  });
});
