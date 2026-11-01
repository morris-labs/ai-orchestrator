import { describe, expect, it } from "vitest";
import { engineIdentityFiles, expectedEngineVersion } from "../../src/docker/engine-identity.js";
import { ImageVersions, imageStatus } from "../../src/docker/image.js";
import { MemoryDocker } from "../../src/docker/memory.js";

const readFrom = (files: Record<string, string>) => (file: string) => {
  const text = files[file];
  if (text === undefined) throw new Error("ENOENT");
  return text;
};

describe("expectedEngineVersion", () => {
  const files = engineIdentityFiles("/repo", "/repo/image");

  it("looks in the engine's dist first, then the image context", () => {
    expect(files).toEqual([
      "/repo/packages/engine/dist/identity",
      "/repo/image/dist/engine-identity",
    ]);
  });

  it("appends the content hash to the version", () => {
    const read = readFrom({ [files[0]!]: "0123456789ab\n" });
    expect(expectedEngineVersion("4.0.0-dev", files, read)).toBe("4.0.0-dev+0123456789ab");
  });

  it("prefers the checkout over the packed context", () => {
    const read = readFrom({ [files[0]!]: "aaaaaaaaaaaa", [files[1]!]: "bbbbbbbbbbbb" });
    expect(expectedEngineVersion("4.0.0-dev", files, read)).toBe("4.0.0-dev+aaaaaaaaaaaa");
  });

  it("falls back to the packed context, then to the plain version", () => {
    expect(
      expectedEngineVersion("4.0.0-dev", files, readFrom({ [files[1]!]: "bbbbbbbbbbbb" })),
    ).toBe("4.0.0-dev+bbbbbbbbbbbb");
    expect(expectedEngineVersion("4.0.0-dev", files, readFrom({}))).toBe("4.0.0-dev");
    expect(expectedEngineVersion("4.0.0-dev", files, readFrom({ [files[0]!]: "not a hash" }))).toBe(
      "4.0.0-dev",
    );
  });
});

describe("a stale engine image", () => {
  async function status(imageEngine: string, expected: string) {
    const docker = new MemoryDocker();
    docker.addImage("claude-code", { "agentbox.engine-version": imageEngine });
    return imageStatus(new ImageVersions(docker), docker, "claude-code", expected);
  }

  it("reads as stale when it was built before the content hash existed", async () => {
    const s = await status("4.0.0-dev", "4.0.0-dev+0123456789ab");
    expect(s.engineMatches).toBe(false);
    expect(s.engineVersion).toBe("4.0.0-dev");
  });

  it("reads as stale when the hash differs", async () => {
    expect((await status("4.0.0-dev+aaaaaaaaaaaa", "4.0.0-dev+bbbbbbbbbbbb")).engineMatches).toBe(
      false,
    );
  });

  it("matches when the hash is the same", async () => {
    expect((await status("4.0.0-dev+aaaaaaaaaaaa", "4.0.0-dev+aaaaaaaaaaaa")).engineMatches).toBe(
      true,
    );
  });
});
