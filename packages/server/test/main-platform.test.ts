import path from "node:path";
import { describe, expect, it } from "vitest";
import { execStartLine, helpText, parseServerArgs, serverCommand } from "../src/main.js";
import { hostPlatform } from "../src/platform/host.js";

describe("main on each host", () => {
  it("reads --log-file in both forms and leaves it out when absent", () => {
    expect(parseServerArgs(["--log-file", "/srv/aio.log"], {}).logFile).toBe("/srv/aio.log");
    expect(parseServerArgs(["--log-file=rel.log"], {}).logFile).toBe(path.resolve("rel.log"));
    expect(parseServerArgs([], {})).not.toHaveProperty("logFile");
    expect(parseServerArgs(["--log-file"], {}).error).toMatch(/needs a file/);
  });

  it("starts the Linux service from the installed package", () => {
    const argv = serverCommand("/srv/data");
    expect(argv).toEqual(["/usr/bin/aio-server", "--data-dir", "/srv/data"]);
    expect(execStartLine("/srv/data")).toBe("/usr/bin/aio-server --data-dir /srv/data");
  });

  it("describes the service each host installs in its help", () => {
    expect(helpText(hostPlatform("linux", { home: "/home/alex" }))).toContain(
      "install-service writes ~/.config/systemd/user/aio-server.service and enables it.",
    );
    expect(helpText(hostPlatform("darwin", { home: "/Users/alex" }))).toContain(
      "install-service writes ~/Library/LaunchAgents/dev.aio.server.plist and loads it with launchctl.",
    );
    expect(helpText(hostPlatform("win32"))).toContain(
      "install-service registers the Task Scheduler task aio-server, which starts the server at logon.",
    );
  });
});
