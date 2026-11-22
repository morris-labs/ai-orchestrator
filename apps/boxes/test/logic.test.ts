import type { BoxView, ConversationSummary } from "@aio/contracts";
import { makeBox, makeBoxView, makeEvent, makeProject, makeSettings } from "@aio/ui/testing";
import { describe, expect, it } from "vitest";
import { matchesFilter, visibleBoxes } from "../src/logic/filter";
import { formatBytes, relativeTime } from "../src/logic/format";
import { purgePreviewList, resumableBoxes, resumeDetail, runningOnDir } from "../src/logic/lists";
import {
  formatMount,
  mountProblems,
  parseMountLine,
  parseMountText,
  tcpMapProblems,
  toTcpMaps,
} from "../src/logic/mounts";
import {
  autoFillName,
  conversationLabel,
  createBody,
  defaultLayout,
  formFromBox,
  normalizeDir,
  slugify,
  updateBody,
  validateForm,
  worktreeAllowed,
  type BoxForm,
} from "../src/logic/newBox";
import { formatForward, parseForward, rowsToForwards, validTarget } from "../src/logic/ssh";
import { displayName, statusBarText, updatedText } from "../src/logic/status";
import {
  applyBoxChanged,
  applyPorts,
  applyStats,
  listenersForBox,
  projectCounts,
  proxyUrl,
  settleTransient,
  withTransient,
} from "../src/logic/store";
import {
  closeBoxTabs,
  closeOthers,
  closeTab,
  emptyTabs,
  markEnded,
  openTab,
  pickTab,
  syncTitles,
  stepTab,
  tabTitle,
} from "../src/logic/tabs";

const v = (
  id: string,
  status: BoxView["status"] = "stopped",
  extra: Partial<BoxView["box"]> = {},
) => makeBoxView({ box: { id: `aio-agent-${id}`, targetDir: `/w/${id}`, ...extra }, status });

describe("filter", () => {
  const b = v("alpha", "running", { conversationName: "Emails", targetDir: "/home/u/site" });
  it.each([
    ["", true],
    ["running", true],
    ["/home/u", true],
    ["emails", true],
    ["aio-agent-alpha", true],
    ["proj-", true],
    ["nope", false],
  ])("matches %s: %s", (needle, expected) => {
    expect(matchesFilter(b, needle)).toBe(expected);
  });
  it("narrows by project and text", () => {
    const other = v("beta", "stopped", { projectId: "other-00000000" });
    expect(visibleBoxes([b, other], null, "").length).toBe(2);
    expect(visibleBoxes([b, other], "other-00000000", "").map((x) => x.box.id)).toEqual([
      "aio-agent-beta",
    ]);
    expect(visibleBoxes([b, other], null, "Not running").map((x) => x.box.id)).toEqual([
      "aio-agent-beta",
    ]);
  });
});

describe("status bar", () => {
  it("counts running and not running, and what the filter hides", () => {
    const all = [v("a", "running"), v("b"), v("c"), v("d", "starting")];
    expect(statusBarText(all, 4)).toBe("1 running \u00b7 2 not running");
    expect(statusBarText(all, 2)).toBe("1 running \u00b7 2 not running \u00b7 2 hidden by filter");
  });
  it("formats the update time", () => {
    expect(updatedText(new Date(2026, 9, 28, 7, 5, 9))).toBe("updated 07:05:09");
  });
  it("names a box by its conversation", () => {
    expect(displayName(v("x", "stopped", { conversationName: "" }))).toBe("x");
  });
});

describe("format", () => {
  it("formats bytes and times", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GiB");
    const now = new Date("2026-10-28T10:00:00Z");
    expect(relativeTime("2026-10-28T09:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-28T09:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-10-28T05:00:00Z", now)).toBe("5 h ago");
    expect(relativeTime("2026-10-27T09:00:00Z", now)).toBe("1 day ago");
  });
});

describe("tabs", () => {
  it("reuses a live tab and replaces an ended one", () => {
    let s = openTab(emptyTabs, { boxId: "a", title: "A" });
    const first = s.current;
    s = openTab(s, { boxId: "a", title: "A" });
    expect(s.tabs).toHaveLength(1);
    expect(s.current).toBe(first);
    s = markEnded(s, first as string, 1);
    expect(tabTitle(s.tabs[0] as never)).toBe("A (ended)");
    s = openTab(s, { boxId: "a", title: "A" });
    expect(s.tabs).toHaveLength(1);
    expect(s.current).not.toBe(first);
    expect(s.tabs[0]?.ended).toBe(false);
  });
  it("keeps side sessions in their own tabs", () => {
    let s = openTab(emptyTabs, { boxId: "a", title: "A" });
    s = openTab(s, { boxId: "a", kind: "side", platform: "codex", title: "A (Codex)" });
    expect(s.tabs).toHaveLength(2);
  });
  it("steps, picks, and closes", () => {
    let s = emptyTabs;
    for (const id of ["a", "b", "c"]) s = openTab(s, { boxId: id, title: id });
    const [a, b, c] = s.tabs.map((t) => t.key);
    expect(stepTab(s, 1).current).toBe(a);
    expect(stepTab(s, -1).current).toBe(b);
    expect(pickTab(s, 2).current).toBe(b);
    expect(pickTab(s, 9).current).toBe(c);
    s = closeTab(pickTab(s, 2), b as string);
    expect(s.current).toBe(c);
    s = closeTab(s, c as string);
    expect(s.current).toBe(a);
    expect(closeOthers(openTab(s, { boxId: "z", title: "z" }), a as string).tabs).toHaveLength(1);
    expect(closeBoxTabs(s, "a").tabs).toHaveLength(0);
    let t = openTab(s, { boxId: "a", kind: "side", platform: "codex", title: "a (Codex)" });
    t = syncTitles(t, new Map([["a", "New"]]), (p) => (p === "codex" ? "Codex" : p));
    expect(t.tabs.map((x) => x.title)).toEqual(["New", "New (Codex)"]);
    expect(syncTitles(t, new Map([["a", "New"]]), () => "Codex")).toBe(t);
  });
});

describe("new box form", () => {
  const base: BoxForm = {
    platform: "claude",
    targetDir: "/w/site",
    conversation: "",
    name: "",
    model: "claude-opus-5-5",
    effort: "high",
    layout: "root",
    skipPermissions: true,
    account: "",
    sshRemoteRefs: [],
  };
  it("slugifies as slugifyIssueName does", () => {
    expect(slugify("Emails not sending!")).toBe("Emails_not_sending");
    expect(slugify("  --  ")).toBe("");
    expect(normalizeDir("/w/site///")).toBe("/w/site");
  });
  it("needs a directory and, for a worktree or workspace, a name", () => {
    expect(validateForm({ ...base, targetDir: "" }, "new")).toEqual(["Choose a target directory."]);
    expect(validateForm({ ...base, targetDir: "rel/dir" }, "new")[0]).toMatch(/absolute/);
    expect(validateForm({ ...base, targetDir: "~/src/app" }, "new")[0]).toMatch(/absolute/);
    expect(validateForm({ ...base, layout: "worktree", name: "!!" }, "new")[0]).toMatch(
      /worktree is named/,
    );
    expect(validateForm({ ...base, layout: "workspace", name: "Fix it" }, "new")).toEqual([]);
    expect(validateForm({ ...base, model: " " }, "new")).toEqual(["Choose a model."]);
    expect(validateForm({ ...base, platform: "codex", model: "" }, "new")).toEqual([]);
    expect(validateForm({ ...base, targetDir: "", layout: "worktree" }, "edit")).toEqual([]);
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(
      validateForm({ ...base, name: "!!", layout: "worktree", conversation: uuid }, "new"),
    ).toEqual([]);
  });
  it("picks the remembered layout", () => {
    const repo = makeProject({ root: "/w/site", primaryRepo: "/w/site" });
    const plain = makeProject({ root: "/w/site" });
    const settings = makeSettings({
      newBoxDefaults: { worktreeDirs: { "/w/site": false }, workspaceDirs: { "/w/site": true } },
    });
    expect(defaultLayout("/w/site", makeSettings(), repo)).toBe("worktree");
    expect(defaultLayout("/w/site/", settings, repo)).toBe("workspace");
    expect(defaultLayout("/w/site", makeSettings(), plain)).toBe("root");
    // An executable new-issue.sh seeds "workspace" until the directory has an answer.
    expect(defaultLayout("/w/site", makeSettings(), plain, true)).toBe("workspace");
    const no = makeSettings({
      newBoxDefaults: { worktreeDirs: {}, workspaceDirs: { "/w/site": false } },
    });
    expect(defaultLayout("/w/site", no, plain, true)).toBe("root");
    expect(worktreeAllowed(plain)).toBe(false);
    expect(worktreeAllowed(undefined)).toBe(true);
  });
  it("fills the name from a picked conversation but never over typed text", () => {
    const c = { title: "Fix login" } as ConversationSummary;
    const d = { title: "Other" } as ConversationSummary;
    let r = autoFillName("", null, c);
    expect(r).toEqual({ name: "Fix login", lastAuto: "Fix login" });
    r = autoFillName(r.name, r.lastAuto, d);
    expect(r.name).toBe("Other");
    r = autoFillName(r.name, r.lastAuto, null);
    expect(r.name).toBe("");
    expect(autoFillName("Typed", "Other", c).name).toBe("Typed");
    expect(autoFillName("Typed", null, null).name).toBe("Typed");
  });
  it("labels conversations", () => {
    const c: ConversationSummary = {
      sessionUuid: "11111111-1111-4111-8111-111111111111",
      title: "Fix login",
      titleSource: "ai-title",
      turns: 3,
      modifiedAt: "2026-10-28T09:00:00Z",
      sizeBytes: 10,
      lastPrompt: "",
      trackedBy: ["aio-agent-a"],
    };
    expect(conversationLabel(c, new Date("2026-10-28T12:00:00Z"))).toBe(
      "Fix login [aio-agent-a] \u00b7 3 h ago \u00b7 3 turns",
    );
  });
  it("builds create bodies for new, adopt, and fork", () => {
    expect(createBody(base, "new").conversation).toEqual({ mode: "new" });
    expect(
      createBody({ ...base, conversation: "11111111-1111-4111-8111-111111111111" }, "new")
        .conversation,
    ).toEqual({
      mode: "adopt",
      sessionUuid: "11111111-1111-4111-8111-111111111111",
    });
    // Adopting provisions nothing, so it neither picks nor remembers a layout.
    const adopt = createBody(
      { ...base, layout: "worktree", conversation: "11111111-1111-4111-8111-111111111111" },
      "new",
    );
    expect(adopt.layout).toBe("root");
    expect(adopt.rememberLayout).toBe(false);
    expect(createBody({ ...base, layout: "workspace" }, "new").rememberLayout).toBe(true);
    const fork = createBody(base, "fork", { forkFrom: "aio-agent-a" });
    expect(fork.conversation).toEqual({ mode: "fork", fromBoxId: "aio-agent-a" });
    expect(fork.rememberLayout).toBe(false);
    const codex = createBody(
      { ...base, platform: "codex", model: "gpt-5-mini", effort: "minimal" },
      "new",
    );
    expect(codex).toMatchObject({ model: "gpt-5-mini", effort: "minimal" });
    expect(createBody(base, "new", { force: true }).force).toBe(true);
  });
  it("sends the chosen account for the platform, and diffs an account change", () => {
    expect(createBody(base, "new").accounts).toBeUndefined();
    expect(createBody({ ...base, account: "claude/work" }, "new").accounts).toEqual({
      claude: "claude/work",
    });
    const box = makeBox({
      id: "aio-agent-a",
      targetDir: "/w/a",
      sessionUuid: "11111111-1111-4111-8111-111111111111",
      accounts: { claude: "claude/work" },
    });
    const form = formFromBox(box, "edit", { model: "m", effort: "high" });
    expect(form.account).toBe("claude/work");
    expect(formFromBox(box, "fork", { model: "m", effort: "high" }).account).toBe("claude/work");
    const hand = { model: false, effort: false };
    expect(updateBody(box, form, hand).accounts).toBeUndefined();
    expect(updateBody(box, { ...form, account: "" }, hand).accounts).toEqual({ claude: null });
    expect(updateBody(box, { ...form, account: "claude/home" }, hand).accounts).toEqual({
      claude: "claude/home",
    });
  });
  it("seeds edit and fork forms from a box and diffs the edit", () => {
    const box = makeBox({
      id: "aio-agent-a",
      targetDir: "/w/a",
      conversationName: "A",
      model: "claude-sonnet-5",
      sessionUuid: "11111111-1111-4111-8111-111111111111",
      worktree: "/w/a/.worktrees/A",
    });
    const fork = formFromBox(box, "fork", { model: "m", effort: "high" });
    expect(fork.name).toBe("A (fork)");
    expect(fork.conversation).toBe("");
    const edit = formFromBox(box, "edit", { model: "m", effort: "high" });
    expect(edit.layout).toBe("worktree");
    const untouched = { model: false, effort: false };
    // The record leaves effort to the settings: the shown default isn't a change.
    expect(updateBody(box, edit, untouched)).toEqual({});
    expect(updateBody(box, edit, { model: false, effort: true })).toEqual({ effort: "high" });
    expect(updateBody(box, { ...edit, model: "claude-opus-5" }, untouched)).toEqual({
      model: "claude-opus-5",
    });
    const unpinned = makeBox({ id: "aio-agent-b", targetDir: "/w/b", conversationName: "B" });
    const unpinnedForm = formFromBox(unpinned, "edit", { model: "m", effort: "high" });
    expect(updateBody(unpinned, { ...unpinnedForm, name: "C" }, untouched)).toEqual({
      conversationName: "C",
    });
    expect(updateBody(unpinned, unpinnedForm, { model: true, effort: false })).toEqual({
      model: "m",
    });
    expect(
      updateBody(
        box,
        { ...edit, conversation: "", effort: box.effort ?? "high", name: "B" },
        untouched,
      ),
    ).toMatchObject({
      sessionUuid: null,
      conversationName: "B",
    });
  });
});

describe("mounts and ports", () => {
  it("parses mount lines", () => {
    expect(parseMountLine("/a")).toEqual({ host: "/a", container: "/a" });
    expect(parseMountLine("/a:/b")).toEqual({ host: "/a", container: "/b" });
    expect(parseMountLine("  ")).toBeNull();
    expect(formatMount({ host: "/a", container: "/a" })).toBe("/a");
    expect(formatMount({ host: "/a", container: "/b" })).toBe("/a:/b");
  });
  it("flags relative paths and repeated box paths", () => {
    expect(mountProblems([{ host: "a", container: "/a" }])[0]).toMatch(/absolute/);
    expect(mountProblems([{ host: "~/data", container: "/data" }])[0]).toMatch(/absolute/);
    expect(parseMountText("/a:/x\n/b:/x").problems[0]).toMatch(/two mounts/);
  });
  it("checks TCP maps and mirrors an empty box port", () => {
    expect(tcpMapProblems([{ host: "70000", container: "" }])[0]).toMatch(/not a port/);
    expect(
      tcpMapProblems([
        { host: "80", container: "" },
        { host: "80", container: "81" },
      ]),
    ).toEqual(["Host port 80 is mapped twice."]);
    expect(
      toTcpMaps([
        { host: "8080", container: "" },
        { host: "", container: "" },
      ]),
    ).toEqual([{ host: 8080, container: 8080 }]);
  });
});

describe("ssh", () => {
  it("validates targets", () => {
    expect(validTarget("user@host.example.com:2222")).toBe(true);
    expect(validTarget("host")).toBe(true);
    expect(validTarget("user@")).toBe(false);
    expect(validTarget("a b")).toBe(false);
  });
  it("round-trips the 3.3.5 forward spec", () => {
    const f = parseForward("R:localhost:9000:db.example.com:5432");
    expect(f).toEqual({
      direction: "R",
      bindAddress: "localhost",
      bindPort: 9000,
      destHost: "db.example.com",
      destPort: 5432,
    });
    expect(formatForward(f as never)).toBe("R:localhost:9000:db.example.com:5432");
    expect(parseForward("X:a:1:b:2")).toBeNull();
    expect(parseForward("L:a:0:b:2")).toBeNull();
  });
  it("reports bad rows", () => {
    const r = rowsToForwards([
      { direction: "L", bindAddress: "", bindPort: "8080", destHost: "localhost", destPort: "80" },
      { direction: "L", bindAddress: "", bindPort: "", destHost: "", destPort: "" },
    ]);
    expect(r.forwards).toHaveLength(1);
    expect(r.forwards[0]?.bindAddress).toBe("localhost");
    expect(r.problems).toEqual([
      "Forward 2 needs a bind port, a destination host, and a destination port.",
    ]);
  });
});

describe("lists", () => {
  it("offers a resume only when nothing runs", () => {
    const was = v("a", "stopped", { wasRunning: true });
    expect(resumableBoxes([was, v("b")]).map((b) => b.box.id)).toEqual(["aio-agent-a"]);
    expect(resumableBoxes([was, v("c", "running")])).toEqual([]);
    expect(resumeDetail(["x"])).toBe("1 box was running before the last shutdown:\n\n  x");
    expect(resumeDetail(["x", "y"])).toBe(
      "2 boxes were running before the last shutdown:\n\n  x\n  y",
    );
  });
  it("lists what Purge removes and refuses on a running box", () => {
    const a = v("a", "stopped", { targetDir: "/w/my.site", worktree: "/w/my.site/.worktrees/x" });
    const b = v("b", "running", { targetDir: "/w/my.site" });
    expect(
      purgePreviewList({
        dryRun: true,
        removedRecords: ["aio-agent-a"],
        removedTranscriptDirs: ["/home/user/.claude/projects/-w-my-site"],
      }),
    ).toEqual(["/home/user/.claude/projects/-w-my-site", "the record of aio-agent-a"]);
    expect(runningOnDir([a, b], "/w/my.site")?.box.id).toBe("aio-agent-b");
    const starting = v("c", "starting", { targetDir: "/w/other/" });
    expect(runningOnDir([starting], "/w/other")?.box.id).toBe("aio-agent-c");
    expect(
      runningOnDir([v("d", "stopped", { targetDir: "/w/other" })], "/w/other"),
    ).toBeUndefined();
  });
});

describe("settleTransient", () => {
  it("drops an overlay once the server reports progress on it", () => {
    const t = new Map<string, BoxView["status"]>([
      ["a", "starting"],
      ["b", "stopping"],
    ]);
    expect(settleTransient(t, "a", "stopped")).toBe(t);
    expect(settleTransient(t, "a", "running").has("a")).toBe(false);
    expect(settleTransient(t, "b", "running")).toBe(t);
    expect(settleTransient(t, "b", "stopped").has("b")).toBe(false);
    expect(settleTransient(t, "c", "running")).toBe(t);
  });
});

describe("store", () => {
  it("applies box.changed, including removal and unknown boxes", () => {
    const a = v("a");
    const changed = makeEvent("box.changed", {
      boxId: a.box.id,
      status: "running",
      box: { ...a.box, conversationName: "Renamed" },
    });
    const r = applyBoxChanged([a], changed);
    expect(r.boxes[0]?.status).toBe("running");
    expect(r.boxes[0]?.box.conversationName).toBe("Renamed");
    expect(
      applyBoxChanged(
        [a],
        makeEvent("box.changed", { boxId: a.box.id, status: "stopped", box: null }),
      ).boxes,
    ).toEqual([]);
    expect(applyBoxChanged([], changed).unknown).toBe(true);
  });
  it("drops the live-session state of a box that stopped", () => {
    const a = makeBoxView({
      box: { id: "aio-agent-a", targetDir: "/w/a" },
      status: "running",
      stats: { cpuPercent: 5, memBytes: 1, memLimitBytes: 2 },
      listeners: [{ port: 5173, proto: "tcp", process: "node", boxId: "aio-agent-a" }],
      proxyUrls: [{ port: 5173, url: "http://5173.a.localhost:21401/" }],
      sideSessions: ["codex"],
    });
    const stopped = applyBoxChanged(
      [a],
      makeEvent("box.changed", { boxId: a.box.id, status: "stopped", box: a.box }),
    ).boxes[0]!;
    expect(stopped.stats).toBeNull();
    expect(stopped.listeners).toEqual([]);
    expect(stopped.proxyUrls).toEqual([]);
    expect(stopped.sideSessions).toEqual([]);
    const running = applyBoxChanged(
      [a],
      makeEvent("box.changed", { boxId: a.box.id, status: "running", box: a.box }),
    ).boxes[0]!;
    expect(running.stats).toEqual(a.stats);
  });
  it("applies stats and ports per container", () => {
    const a = v("a", "running");
    const b = v("b", "running", { projectId: a.box.projectId });
    const stats = applyStats(
      [a, b],
      makeEvent("container.stats", {
        container: a.container,
        projectId: a.box.projectId,
        cpuPercent: 50,
        memBytes: 10,
        memLimitBytes: 100,
        diskBytes: 5,
      }),
    );
    expect(stats.every((x) => x.stats?.cpuPercent === 50)).toBe(true);
    const ports = applyPorts(
      [a, b],
      makeEvent("ports.changed", {
        container: a.container,
        listeners: [
          { port: 5173, proto: "tcp", process: "node", boxId: a.box.id },
          { port: 9000, proto: "tcp", process: null, boxId: null },
        ],
      }),
      21400,
    );
    expect(ports[0]?.proxyUrls).toEqual([
      { port: 5173, url: proxyUrl(5173, a.box.hostKey, 21400) },
    ]);
    expect(ports[1]?.proxyUrls).toEqual([]);
    expect(proxyUrl(5173, "site", 21400)).toBe("http://5173.site.localhost:21400/");
    expect(
      listenersForBox(a, [{ port: 1, proto: "tcp", process: null, boxId: null }], 1),
    ).toHaveLength(1);
  });
  it("recounts projects and overlays transitions", () => {
    const a = v("a", "running");
    const p = {
      project: makeProject({ root: "/w/a", id: a.box.projectId }),
      running: 0,
      total: 0,
      container: null,
    };
    expect(projectCounts([p], [a])[0]).toMatchObject({ running: 1, total: 1 });
    expect(withTransient([a], new Map([[a.box.id, "stopping"]]))[0]?.status).toBe("stopping");
  });
});

describe("Windows paths", () => {
  it("parse and format mounts with a drive letter", () => {
    expect(parseMountLine("C:\\data")).toEqual({ host: "C:\\data", container: "/mnt/host/c/data" });
    expect(parseMountLine("C:\\data:/data")).toEqual({ host: "C:\\data", container: "/data" });
    expect(parseMountLine("D:/x y:")).toEqual({ host: "D:/x y", container: "/mnt/host/d/x y" });
    expect(formatMount({ host: "C:\\data", container: "/mnt/host/c/data" })).toBe("C:\\data");
    expect(formatMount({ host: "C:\\data", container: "/data" })).toBe("C:\\data:/data");
  });

  it("accept drive paths and refuse UNC paths as mount sources", () => {
    expect(mountProblems([{ host: "C:\\data", container: "/mnt/host/c/data" }])).toEqual([]);
    expect(mountProblems([{ host: "\\\\server\\share", container: "/share" }])[0]).toMatch(/UNC/);
  });

  it("normalize a directory to the server's stored form", () => {
    expect(normalizeDir(" c:\\Users\\dev\\app\\ ")).toBe("C:/Users/dev/app");
    expect(normalizeDir("/w/site/")).toBe("/w/site");
  });

  it("accept an absolute Windows target directory", () => {
    const base = {
      targetDir: "C:\\Users\\dev\\app",
      layout: "root",
      name: "x",
      conversation: "",
      model: "claude-opus-5-5",
      platform: "claude",
    };
    expect(validateForm(base as never, "new")).toEqual([]);
    expect(validateForm({ ...base, targetDir: "C:app" } as never, "new")[0]).toMatch(/absolute/);
  });
});
