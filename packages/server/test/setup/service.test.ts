import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installService, serviceInstalled, unitFile, unitPath } from "../../src/systemd/service.js";
import { FakeRunner } from "./fake-runner.js";
import { tempDir } from "../tmp.js";

let home: string;
beforeEach(async () => {
  home = tempDir("agentbox-service-");
});
afterEach(async () => rm(home, { recursive: true, force: true }));

describe("systemd user service", () => {
  it("writes the unit content", () => {
    const unit = unitFile({ execStart: "/usr/bin/node /opt/agentbox/main.js" });
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/agentbox/main.js\n");
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain("WantedBy=default.target\n");
    expect(unit.startsWith("[Unit]\nDescription=Agent Box server\n")).toBe(true);
  });

  it("matches the packaged unit", async () => {
    const packaged = await readFile(
      new URL("../../../../packaging/systemd/agentbox-server.service", import.meta.url),
      "utf8",
    );
    expect(packaged).toBe(unitFile({ execStart: "/usr/bin/agentbox-server" }));
  });

  it("installs and enables the service", async () => {
    const runner = new FakeRunner();
    expect(await serviceInstalled(home)).toBe(false);
    const { path } = await installService({ home, execStart: "/usr/bin/agentbox-server", runner });
    expect(path).toBe(unitPath(home));
    expect(path).toBe(join(home, ".config/systemd/user/agentbox-server.service"));
    expect(await readFile(path, "utf8")).toContain("ExecStart=/usr/bin/agentbox-server");
    expect(runner.runs.map((r) => r.argv)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "agentbox-server.service"],
    ]);
    expect(await serviceInstalled(home)).toBe(true);
  });

  it("fails with systemctl's output", async () => {
    const runner = new FakeRunner((argv) =>
      argv.includes("enable") ? { code: 1, stderr: "Failed to connect to bus" } : {},
    );
    await expect(
      installService({ home, execStart: "/usr/bin/agentbox-server", runner }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Failed to connect to bus"),
    });
  });
});
