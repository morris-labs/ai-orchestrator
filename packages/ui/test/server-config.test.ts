// How the Electron main processes find the server's data directory and origin.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataFile, serverUrl } from "../src/electron/server-config";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentbox-ui-config-"));
  dirs.push(dir);
  return dir;
}

describe("dataFile", () => {
  it("resolves a HOME_PATHS entry in AGENTBOX_DATA_DIR, else under the home directory", () => {
    expect(dataFile(".claude-box/config.json", {}, "/home/tester")).toBe(
      path.join("/home/tester", ".claude-box", "config.json"),
    );
    expect(dataFile(".claude-box/server.token", { AGENTBOX_DATA_DIR: "/srv/data" }, "/x")).toBe(
      path.join(path.resolve("/srv/data"), "server.token"),
    );
  });
});

describe("serverUrl", () => {
  it("uses the default port when config.json is missing or has no serverPort", () => {
    const data = tempDir();
    expect(serverUrl({ AGENTBOX_DATA_DIR: data })).toBe("https://127.0.0.1:21400");
    writeFileSync(path.join(data, "config.json"), JSON.stringify({ other: true }));
    expect(serverUrl({ AGENTBOX_DATA_DIR: data })).toBe("https://127.0.0.1:21400");
    writeFileSync(path.join(data, "config.json"), "{ not json");
    expect(serverUrl({ AGENTBOX_DATA_DIR: data })).toBe("https://127.0.0.1:21400");
  });

  it("reads serverPort from config.json in the data directory", () => {
    const data = tempDir();
    writeFileSync(path.join(data, "config.json"), JSON.stringify({ serverPort: 21555 }));
    expect(serverUrl({ AGENTBOX_DATA_DIR: data })).toBe("https://127.0.0.1:21555");
  });

  it("prefers the port the running server wrote to server.port", () => {
    const data = tempDir();
    writeFileSync(path.join(data, "config.json"), JSON.stringify({ serverPort: 21555 }));
    writeFileSync(path.join(data, "server.port"), "21600\n");
    expect(serverUrl({ AGENTBOX_DATA_DIR: data })).toBe("https://127.0.0.1:21600");
    writeFileSync(path.join(data, "server.port"), "garbage");
    expect(serverUrl({ AGENTBOX_DATA_DIR: data })).toBe("https://127.0.0.1:21555");
  });

  it("reads config.json under the home directory without AGENTBOX_DATA_DIR", () => {
    const home = tempDir();
    const data = path.join(home, ".claude-box");
    mkdirSync(data);
    writeFileSync(path.join(data, "config.json"), JSON.stringify({ serverPort: 21556 }));
    expect(serverUrl({}, home)).toBe("https://127.0.0.1:21556");
  });

  it("prefers AGENTBOX_SERVER_URL and drops its trailing slash", () => {
    const data = tempDir();
    writeFileSync(path.join(data, "config.json"), JSON.stringify({ serverPort: 21555 }));
    expect(
      serverUrl({ AGENTBOX_DATA_DIR: data, AGENTBOX_SERVER_URL: "https://127.0.0.1:9/" }),
    ).toBe("https://127.0.0.1:9");
  });
});
