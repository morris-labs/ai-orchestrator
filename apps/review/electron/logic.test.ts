import type { AgentBoxEvent, RunState } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import {
  ActiveRuns,
  launcherHash,
  noticeFor,
  parseDeepLink,
  rendererUrl,
  trayBitmap,
  trayTooltip,
} from "./logic.js";

describe("parseDeepLink", () => {
  it.each([
    [["electron", "."], null],
    [["app", "agentbox-review://launch?project=p1&box=b1"], { project: "p1", box: "b1" }],
    [["app", "?project=p1"], { project: "p1", box: null }],
    [["app", "--box=claude-agent-x"], { project: null, box: "claude-agent-x" }],
    [["app", "--project=", "--box="], null],
    [["app", "agentbox-review://launch"], null],
  ])("%j", (argv, want) => {
    expect(parseDeepLink(argv)).toEqual(want);
  });
});

describe("renderer URLs", () => {
  it("opens the launcher with the deep link", () => {
    expect(rendererUrl("http://127.0.0.1:20400/", { project: "p", box: null })).toBe(
      "http://127.0.0.1:20400/review/?project=p#/launch",
    );
    expect(rendererUrl("http://127.0.0.1:20400", null)).toBe("http://127.0.0.1:20400/review/");
    expect(launcherHash({ project: "p", box: "b" })).toBe("#/launch?project=p&box=b");
  });
});

const run = (id: string, status: RunState["status"]) => ({ id, status }) as RunState;
const changed = (r: RunState) =>
  ({ type: "run.changed", run: r, roundSummary: null }) as unknown as AgentBoxEvent;

describe("ActiveRuns", () => {
  it("counts active runs from the list and the events", () => {
    const a = new ActiveRuns();
    a.seed([run("1", "running"), run("2", "finished"), run("3", "waiting_decision")]);
    expect(a.count).toBe(2);
    expect(a.apply(changed(run("1", "finished")))).toBe(true);
    expect(a.apply(changed(run("3", "paused")))).toBe(false);
    expect(a.apply({ type: "notification" } as AgentBoxEvent)).toBe(false);
    expect(a.count).toBe(1);
  });
});

describe("noticeFor", () => {
  const on = { decisionNeeded: true, runFinished: true, boxEnded: true, roundSummary: true };
  const notification = (kind: string, extra: object = {}) =>
    ({
      type: "notification",
      notificationId: "n",
      kind,
      title: "T",
      body: "B",
      runId: "01JB8Z5K3W6Q2V9X4T7R0M1N2P",
      boxId: null,
      severity: "info",
      read: false,
      ...extra,
    }) as unknown as AgentBoxEvent;

  it.each([
    ["decision_needed", on, "#/runs/01JB8Z5K3W6Q2V9X4T7R0M1N2P", true],
    ["run_finished", on, "#/runs/01JB8Z5K3W6Q2V9X4T7R0M1N2P", false],
    ["ready_to_push", { ...on, runFinished: false }, null, false],
    ["round_summary", { ...on, roundSummary: false }, null, false],
    ["box_ended", on, null, false],
  ])("%s", (kind, toggles, hash, urgent) => {
    const n = noticeFor(notification(kind), toggles);
    if (hash === null) expect(n).toBeNull();
    else expect(n).toMatchObject({ hash, urgent, title: "T" });
  });

  it("skips read notifications and opens the run list without a run", () => {
    expect(noticeFor(notification("run_finished", { read: true }), on)).toBeNull();
    expect(noticeFor(notification("run_finished", { runId: null }), on)?.hash).toBe("#/runs");
  });
});

describe("tray", () => {
  it("describes the count", () => {
    expect(trayTooltip(0)).toMatch(/no active runs/);
    expect(trayTooltip(1)).toMatch(/1 active run$/);
    expect(trayTooltip(3)).toMatch(/3 active runs/);
  });

  it("draws a ring when idle and a filled badge with digits when busy", () => {
    const px = (buf: Buffer, x: number, y: number) => [
      ...buf.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4),
    ];
    const idle = trayBitmap(0);
    const busy = trayBitmap(12);
    expect(idle).toHaveLength(32 * 32 * 4);
    expect(px(idle, 16, 16)[3]).toBe(0);
    expect(px(idle, 16, 1)[3]).toBe(255);
    const white = [...Array(32 * 32).keys()].filter(
      (i) => busy[i * 4] === 255 && busy[i * 4 + 1] === 255,
    );
    expect(white.length).toBeGreaterThan(10);
  });
});
