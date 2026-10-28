// The action enablement table of inventory section 1.4, one row per case.
import type { BoxView } from "@agentbox/contracts";
import { makeBoxView } from "@agentbox/ui/testing";
import { describe, expect, it } from "vitest";
import { actionStates, type ActionId } from "../src/logic/enablement";

const UUID = "11111111-1111-4111-8111-111111111111";

function box(
  id: string,
  status: BoxView["status"],
  extra: Partial<BoxView["box"]> = {},
  review = false,
): BoxView {
  return makeBoxView({
    box: { id: `claude-agent-${id}`, targetDir: `/w/${id}`, sessionUuid: UUID, ...extra },
    status,
    ...(review
      ? { reviewState: { state: "under_review", runId: "01J00000000000000000000000" } }
      : {}),
  });
}

const running = box("run", "running", { wasRunning: true });
const stopped = box("stop", "stopped");
const stoppedWas = box("was", "stopped", { wasRunning: true });
const starting = box("starting", "starting");
const stopping = box("stopping", "stopping");
const noUuid = box("nouuid", "stopped", { sessionUuid: null });
const workspace = box("ws", "stopped", { workspace: "/w/ws/Fix_it" });
const workspaceRunning = box("wsr", "running", { workspace: "/w/wsr/Fix_it" });
const worktree = box("wt", "stopped", {
  worktree: "/w/wt/.worktrees/x",
  branch: "claude/x",
  workspace: "/w/wt/x",
});
const reviewed = box("rev", "stopped", {}, true);

interface Case {
  name: string;
  selection: BoxView[];
  all?: BoxView[];
  tabs?: number;
  enabled: ActionId[];
}

const ALL_ACTIONS: ActionId[] = [
  "edit",
  "fork",
  "convertToWorktree",
  "purge",
  "moveWorkDir",
  "changeWorkDir",
  "openShell",
  "attach",
  "start",
  "stop",
  "restartAll",
  "remove",
  "stopAll",
  "startAllStopped",
  "closeTab",
  "startReview",
];

const cases: Case[] = [
  { name: "nothing selected, nothing exists", selection: [], all: [], enabled: [] },
  {
    name: "nothing selected, a box runs and a stopped one was running",
    selection: [],
    all: [running, stoppedWas],
    enabled: ["stopAll", "startAllStopped"],
  },
  {
    name: "one stopped box with a session",
    selection: [stopped],
    enabled: [
      "edit",
      "fork",
      "purge",
      "moveWorkDir",
      "changeWorkDir",
      "start",
      "remove",
      "startReview",
    ],
  },
  {
    name: "one running box",
    selection: [running],
    enabled: [
      "edit",
      "fork",
      "purge",
      "openShell",
      "attach",
      "stop",
      "restartAll",
      "stopAll",
      "startReview",
    ],
  },
  {
    name: "fork needs a session uuid",
    selection: [noUuid],
    enabled: ["edit", "purge", "moveWorkDir", "changeWorkDir", "start", "remove", "startReview"],
  },
  {
    name: "a starting box counts for nothing",
    selection: [starting],
    enabled: [],
  },
  {
    name: "a stopping box counts for nothing",
    selection: [stopping],
    enabled: [],
  },
  {
    name: "convert needs a stopped workspace box without a worktree",
    selection: [workspace],
    enabled: [
      "edit",
      "fork",
      "convertToWorktree",
      "purge",
      "moveWorkDir",
      "changeWorkDir",
      "start",
      "remove",
      "startReview",
    ],
  },
  {
    name: "convert is off while the workspace box runs",
    selection: [workspaceRunning],
    enabled: [
      "edit",
      "fork",
      "purge",
      "openShell",
      "attach",
      "stop",
      "restartAll",
      "stopAll",
      "startReview",
    ],
  },
  {
    name: "a worktree box can't be moved, re-pointed, or converted",
    selection: [worktree],
    enabled: ["edit", "fork", "purge", "start", "remove", "startReview"],
  },
  {
    name: "a box under review can't start another review",
    selection: [reviewed],
    enabled: ["edit", "fork", "purge", "moveWorkDir", "changeWorkDir", "start", "remove"],
  },
  {
    name: "several stopped boxes: start and remove only",
    selection: [stopped, stoppedWas],
    enabled: ["start", "remove", "startAllStopped"],
  },
  {
    name: "a mix of running and stopped: no remove",
    selection: [running, stopped],
    enabled: ["start", "stop", "restartAll", "stopAll"],
  },
  {
    name: "transitioning rows count for nothing in a multi-selection",
    selection: [starting, stopping],
    enabled: [],
  },
  { name: "close tab needs an open tab", selection: [], all: [], tabs: 2, enabled: ["closeTab"] },
];

describe("actionStates (inventory 1.4)", () => {
  it.each(cases)("$name", ({ selection, all, tabs, enabled }) => {
    const states = actionStates(selection, all ?? selection, tabs ?? 0);
    const on = ALL_ACTIONS.filter((a) => states[a]);
    expect(on.sort()).toEqual([...enabled].sort());
  });

  it("looks at every box for Stop All, whatever is selected", () => {
    expect(actionStates([stopped], [stopped, running], 0).stopAll).toBe(true);
  });

  it("enables Start All Stopped only for stopped boxes that were running", () => {
    expect(actionStates([], [stopped], 0).startAllStopped).toBe(false);
    expect(actionStates([], [stoppedWas], 0).startAllStopped).toBe(true);
    expect(actionStates([], [running], 0).startAllStopped).toBe(false);
  });
});
