import { readFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { hostPlatform } from "../../src/platform/host.js";
import {
  installServerService,
  serverServiceInstalled,
  serviceSummary,
  systemdExecStart,
  windowsTaskProgram,
} from "../../src/service/index.js";
import {
  LAUNCHD_LABEL,
  installLaunchAgent,
  launchAgentPath,
  launchAgentPathVar,
  launchAgentPlist,
  launchctlCommands,
} from "../../src/service/launchd.js";
import {
  TASK_NAME,
  installScheduledTask,
  schtasksCommands,
  taskUser,
  taskXml,
  taskXmlBytes,
  windowsQuote,
} from "../../src/service/schtasks.js";
import { FakeRunner } from "../setup/fake-runner.js";
import { tempDir } from "../tmp.js";

describe("the launchd agent", () => {
  const plist = launchAgentPlist({
    programArguments: [
      "/Applications/AI Orchestrator.app/Contents/Resources/runtime/node/bin/node",
      "/Applications/AI Orchestrator.app/Contents/Resources/runtime/server/dist/main.js",
      "--data-dir",
      "/Users/alex/a&b",
    ],
    home: "/Users/alex",
    pathDirs: ["/Applications/AI Orchestrator.app/Contents/Resources/runtime/node/bin"],
  });

  it("lives in ~/Library/LaunchAgents under its label", () => {
    expect(launchAgentPath("/Users/alex")).toBe(
      "/Users/alex/Library/LaunchAgents/dev.aio.server.plist",
    );
    expect(plist).toContain(`<key>Label</key>\n\t<string>${LAUNCHD_LABEL}</string>`);
  });

  it("lists every argument as its own string, escaped for XML", () => {
    expect(plist).toContain(
      "\t\t<string>/Applications/AI Orchestrator.app/Contents/Resources/runtime/node/bin/node</string>\n" +
        "\t\t<string>/Applications/AI Orchestrator.app/Contents/Resources/runtime/server/dist/main.js</string>\n" +
        "\t\t<string>--data-dir</string>\n" +
        "\t\t<string>/Users/alex/a&amp;b</string>\n",
    );
  });

  it("restarts on failure, starts at load, and keeps the systemd unit's umask", () => {
    expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n\t\t<false/>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n\t<integer>5</integer>");
    expect(plist).toContain("<key>Umask</key>\n\t<integer>63</integer>");
    expect(plist).toContain("<string>/Users/alex/Library/Logs/aio-server.log</string>");
    expect(plist).toContain("<key>NODE_ENV</key>\n\t\t<string>production</string>");
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
  });

  it("puts the bundled Node.js, Homebrew, and Docker Desktop on PATH", () => {
    expect(launchAgentPathVar(["/opt/node/bin", "/usr/bin"])).toBe(
      "/opt/node/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:" +
        "/Applications/Docker.app/Contents/Resources/bin:/bin:/usr/sbin:/sbin",
    );
    expect(plist).toContain(
      "<string>/Applications/AI Orchestrator.app/Contents/Resources/runtime/node/bin:/opt/homebrew/bin:",
    );
  });

  it("boots out the old agent, enables, and bootstraps into the GUI domain", () => {
    expect(launchctlCommands(501, "/p.plist")).toEqual([
      { args: ["bootout", "gui/501/dev.aio.server"], mayFail: true },
      { args: ["enable", "gui/501/dev.aio.server"], mayFail: false },
      { args: ["bootstrap", "gui/501", "/p.plist"], mayFail: false },
    ]);
  });

  it("writes the plist and runs launchctl, ignoring a bootout of an agent that isn't loaded", async () => {
    const home = tempDir("aio-launchd-");
    const runner = new FakeRunner((argv) =>
      argv[1] === "bootout" ? { code: 3, stderr: "No such process" } : {},
    );
    const { path } = await installLaunchAgent({
      home,
      uid: 501,
      programArguments: ["/n", "/m.js"],
      runner,
    });
    expect(path).toBe(launchAgentPath(home));
    expect(await readFile(path, "utf8")).toContain("<string>/m.js</string>");
    expect(runner.runs.map((r) => r.argv[0])).toEqual(["launchctl", "launchctl", "launchctl"]);
  });

  it("fails with launchctl's output when bootstrap fails", async () => {
    const runner = new FakeRunner((argv) =>
      argv[1] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error" } : {},
    );
    await expect(
      installLaunchAgent({
        home: tempDir("aio-launchd-"),
        uid: 501,
        programArguments: ["/n"],
        runner,
      }),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Input/output") });
  });
});

describe("the Windows logon task", () => {
  it("quotes arguments the way CommandLineToArgvW reads them", () => {
    expect(windowsQuote("C:\\aio\\main.js")).toBe("C:\\aio\\main.js");
    expect(windowsQuote("C:\\Program Files\\aio")).toBe('"C:\\Program Files\\aio"');
    expect(windowsQuote("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(windowsQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(windowsQuote("")).toBe('""');
  });

  it("names the account from the environment", () => {
    expect(taskUser({ USERDOMAIN: "WORKSTATION", USERNAME: "alex" })).toBe("WORKSTATION\\alex");
    expect(taskUser({ USERNAME: "alex" })).toBe("alex");
    expect(taskUser({})).toBeUndefined();
  });

  const xml = taskXml({
    command:
      "C:\\Users\\alex\\AppData\\Local\\Programs\\ai-orchestrator\\resources\\runtime\\node\\aio-serverw.exe",
    args: [
      "C:\\Program Files\\x\\main.js",
      "--log-file",
      "C:\\Users\\alex\\.ai-orchestrator\\server.log",
    ],
    workingDirectory: "C:\\Users\\alex",
    user: "WORKSTATION\\alex",
  });

  it("starts at the user's logon and again every 5 minutes, without a time limit", () => {
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("      <UserId>WORKSTATION\\alex</UserId>");
    expect(xml).toContain("<Interval>PT5M</Interval>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });

  it("runs the program with quoted, XML-escaped arguments", () => {
    expect(xml).toContain("aio-serverw.exe</Command>");
    expect(xml).toContain(
      "<Arguments>&quot;C:\\Program Files\\x\\main.js&quot; --log-file C:\\Users\\alex\\.ai-orchestrator\\server.log</Arguments>",
    );
    expect(xml).toContain("<WorkingDirectory>C:\\Users\\alex</WorkingDirectory>");
    expect(xml.split("\r\n").length).toBeGreaterThan(10);
  });

  it("leaves the user out when it's unknown", () => {
    const anon = taskXml({ command: "n.exe", args: [], workingDirectory: "C:\\" });
    expect(anon).not.toContain("<UserId>");
  });

  it("encodes the file as UTF-16 with a byte order mark", () => {
    const bytes = taskXmlBytes("<a/>");
    expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00]);
  });

  it("creates the task from the file, replacing an old one, then runs it", async () => {
    expect(schtasksCommands("C:\\t.xml")).toEqual([
      ["/Create", "/TN", "aio-server", "/XML", "C:\\t.xml", "/F"],
      ["/Run", "/TN", "aio-server"],
    ]);
    // The paths are Windows paths, so the file lands under a test directory
    // whose name is one odd-looking file on Linux.
    const dir = tempDir("aio-schtasks-");
    const runner = new FakeRunner();
    const xmlFile = join(dir, "task.xml");
    const { path } = await installScheduledTask({
      xmlFile,
      command: "n.exe",
      args: ["m.js"],
      workingDirectory: "C:\\Users\\alex",
      runner,
    });
    expect(path).toBe(`Task Scheduler task ${TASK_NAME}`);
    expect((await readFile(xmlFile)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(runner.runs.map((r) => r.argv)).toEqual(
      schtasksCommands(xmlFile).map((a) => ["schtasks", ...a]),
    );
  });

  it("fails with schtasks' output", async () => {
    const runner = new FakeRunner((argv) =>
      argv[1] === "/Create" ? { code: 1, stderr: "ERROR: Access is denied." } : {},
    );
    await expect(
      installScheduledTask({
        xmlFile: join(tempDir("aio-schtasks-"), "t.xml"),
        command: "n.exe",
        args: [],
        workingDirectory: "C:\\",
        runner,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Access is denied"),
    });
  });
});

describe("install-service on each host", () => {
  it("writes the same systemd unit as before on Linux", async () => {
    const home = tempDir("aio-svc-linux-");
    const runner = new FakeRunner();
    const p = hostPlatform("linux", { home });
    const { path } = await installServerService({
      platform: p,
      command: ["/usr/bin/node", "/opt/aio/main.js", "--data-dir", "/srv/my data"],
      runner,
    });
    expect(path).toBe(join(home, ".config/systemd/user/aio-server.service"));
    expect(await readFile(path, "utf8")).toContain(
      'ExecStart=/usr/bin/node /opt/aio/main.js --data-dir "/srv/my data"\n',
    );
    expect(runner.runs.map((r) => r.argv[0])).toEqual(["systemctl", "systemctl"]);
    expect(await serverServiceInstalled(p, runner)).toBe(true);
    expect(systemdExecStart(["/a b", "c"])).toBe('"/a b" c');
  });

  it("writes a LaunchAgent on macOS with the Node.js directory on PATH", async () => {
    const home = tempDir("aio-svc-mac-");
    const runner = new FakeRunner();
    const p = hostPlatform("darwin", { home, uid: 502 });
    expect(await serverServiceInstalled(p, runner)).toBe(false);
    const { path } = await installServerService({
      platform: p,
      command: ["/opt/aio/node/bin/node", "/opt/aio/server/dist/main.js"],
      runner,
    });
    expect(path).toBe(launchAgentPath(home));
    expect(await readFile(path, "utf8")).toContain("<string>/opt/aio/node/bin:/opt/homebrew/bin:");
    expect(runner.runs.at(-1)?.argv).toEqual(["launchctl", "bootstrap", "gui/502", path]);
    expect(await serverServiceInstalled(p, runner)).toBe(true);
  });

  it("refuses a macOS host without a user id", async () => {
    const p = { ...hostPlatform("darwin"), uid: undefined };
    await expect(
      installServerService({ platform: p, command: ["/n", "/m"], runner: new FakeRunner() }),
    ).rejects.toThrow(/numeric id/);
  });

  it("registers a logon task on Windows that logs to the data directory", async () => {
    const dataDir = tempDir("aio-svc-win-");
    const runner = new FakeRunner();
    const node = "C:\\aio\\runtime\\node\\node.exe";
    const p = hostPlatform("win32", {
      home: "C:\\Users\\alex",
      env: { USERNAME: "alex", USERDOMAIN: "WORKSTATION" },
      exists: (f) => f === "C:\\aio\\runtime\\node\\aio-serverw.exe",
    });
    expect(windowsTaskProgram(p, node)).toBe("C:\\aio\\runtime\\node\\aio-serverw.exe");
    expect(windowsTaskProgram({ ...p, exists: () => false }, node)).toBe(node);
    await installServerService({
      platform: p,
      command: [node, "C:\\aio\\runtime\\server\\dist\\main.js"],
      dataDir,
      runner,
    });
    const create = runner.runs[0]?.argv ?? [];
    expect(create.slice(0, 4)).toEqual(["schtasks", "/Create", "/TN", "aio-server"]);
    const xml = (await readFile(create[5] as string)).toString("utf16le");
    expect(xml).toContain("aio-serverw.exe</Command>");
    expect(xml).toContain(
      `<Arguments>C:\\aio\\runtime\\server\\dist\\main.js --log-file ${win32.join(dataDir, "server.log")}</Arguments>`,
    );
    expect(xml).toContain("<UserId>WORKSTATION\\alex</UserId>");
  });

  it("asks schtasks whether the task exists", async () => {
    const p = hostPlatform("win32");
    expect(await serverServiceInstalled(p, new FakeRunner())).toBe(true);
    expect(await serverServiceInstalled(p, new FakeRunner(() => ({ code: 1 })))).toBe(false);
  });

  it("summarizes what each host installs and where its logs go", () => {
    expect(serviceSummary(hostPlatform("linux", { home: "/home/alex" }))).toEqual({
      kind: "systemd",
      where: "~/.config/systemd/user/aio-server.service",
      logs: "journalctl --user -u aio-server",
    });
    expect(serviceSummary(hostPlatform("darwin", { home: "/Users/alex" }))).toEqual({
      kind: "launchd",
      where: "~/Library/LaunchAgents/dev.aio.server.plist",
      logs: "~/Library/Logs/aio-server.log",
    });
    expect(serviceSummary(hostPlatform("win32"))).toEqual({
      kind: "schtasks",
      where: "the Task Scheduler task aio-server",
      logs: "~\\.ai-orchestrator\\server.log",
    });
  });
});
