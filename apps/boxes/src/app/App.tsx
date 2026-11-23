import appPackage from "../../package.json";
// The main window: menu bar, toolbar, update bars, the Boxes, Builds, and
// Usage tabs, the project list, the box table, the details panel, the terminal
// tabs, and the status bar.
import { LOCAL_MACHINE_ID } from "@aio/contracts";
import {
  type BoxView,
  type BuildSummary,
  type ConvertToWorktreeResult,
  type ImageStatus,
  type Job,
  type Mount,
  type Platform,
  type ProjectSummary,
  type SecretRef,
  type SshRemote,
  type Updates,
} from "@aio/contracts";
import {
  MenuBar,
  UpgradeStatus,
  Splitter,
  errorMessage,
  hasOpenDialog,
  isApiError,
  useApiClient,
  useChords,
  useContextMenu,
  useEvent,
  useMessageBox,
  useMessageBoxOpen,
  useStreamStatus,
  useToast,
  type ChordBinding,
  type MenuEntry,
  type SortState,
} from "@aio/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../bridge";
import { BoxTable, type BuildBadges } from "../components/BoxTable";
import { BuildsView } from "../components/BuildsView";
import { DetailsPanel } from "../components/DetailsPanel";
import { ProjectPanel } from "../components/ProjectPanel";
import { TerminalTabs } from "../components/TerminalTabs";
import { UpdateBars } from "../components/UpdateBars";
import { UsageView } from "../components/UsageView";
import { BoxDialog, type BoxDialogResult } from "../dialogs/BoxDialog";
import { InputDialog } from "../dialogs/InputDialog";
import { JobDialog, createJobMessage, waitForJob } from "../dialogs/JobDialog";
import { MountsDialog } from "../dialogs/MountsDialog";
import { PromptsDialog } from "../dialogs/PromptsDialog";
import { SetupWizard } from "../dialogs/SetupWizard";
import { SshRemotesDialog } from "../dialogs/SshDialogs";
import { activeBuildsByBox } from "../logic/builds";
import { actionStates } from "../logic/enablement";
import { visibleBoxes } from "../logic/filter";
import { formatBytes } from "../logic/format";
import { purgePreviewList, resumableBoxes, resumeDetail, runningOnDir } from "../logic/lists";
import { isLoopbackUrl } from "../logic/machines";
import { createBody, normalizeDir, projectForDir, updateBody, type BoxForm } from "../logic/newBox";
import { PLATFORMS, displayName, platformLabel, statusBarText, updatedText } from "../logic/status";
import { settleTransient, withTransient } from "../logic/store";
import {
  closeBoxTabs,
  closeOthers,
  closeTab,
  emptyTabs,
  markEnded,
  openTab,
  pickTab,
  stepTab,
  syncTitles,
  type TabsState,
} from "../logic/tabs";
import { CHORDS } from "./chords";
import type { DialogState } from "./dialogs";
import { useMachine } from "./machine";
import { useBoxesData } from "./useBoxesData";
import { useBuildsData } from "./useBuildsData";

/** Pixels the table pane keeps: the filter box and a few rows. */
const TABLE_MIN_HEIGHT = 120;
/** Pixels an open terminal pane keeps: the tab strip and about 12 rows. */
const TERMINAL_MIN_HEIGHT = 260;

/** The project settings a box dialog edited: only the parts that changed. */
interface ProjectEdits {
  tcpMaps?: { host: number; container: number }[];
  mounts?: Mount[];
  secretRefs?: SecretRef[];
}

/** The project edits of a dialog result, or `null` when it changed none. */
function projectEdits(r: BoxDialogResult): ProjectEdits | null {
  if (!r.project && !r.secretRefs) return null;
  return {
    ...(r.project ?? {}),
    ...(r.secretRefs ? { secretRefs: r.secretRefs } : {}),
  };
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(`ab.${key}`);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(`ab.${key}`);
    else localStorage.setItem(`ab.${key}`, value);
  } catch {
    // Storage can be unavailable; the setting then lasts for this session only.
  }
}

const PAGES = ["boxes", "builds", "usage"] as const;
type Page = (typeof PAGES)[number];
const PAGE_LABELS: Record<Page, string> = { boxes: "Boxes", builds: "Builds", usage: "Usage" };

export function App() {
  const client = useApiClient();
  const machine = useMachine();
  // Each machine remembers its own project; this PC keeps the old key.
  const projectKey = machine.isLocal ? "selectedProject" : `machine.${machine.id}.selectedProject`;
  const data = useBoxesData();
  const builds = useBuildsData();
  const { ask, confirm, inform } = useMessageBox();
  const messageOpen = useMessageBoxOpen();
  const toast = useToast();
  const streamStatus = useStreamStatus();
  const tableMenu = useContextMenu();

  const [projectId, setProjectId] = useState<string | null>(() => load(projectKey));
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>({ column: "status", direction: "asc" });
  const [tabs, setTabs] = useState<TabsState>(emptyTabs);
  const [page, setPage] = useState<Page>("boxes");
  const [buildId, setBuildId] = useState<string | null>(null);
  const openBuild = useCallback((build: BuildSummary) => {
    setPage("builds");
    setBuildId(build.id);
  }, []);
  const buildBadges = useMemo<BuildBadges>(
    () => ({ byBox: activeBuildsByBox(builds.builds), onOpen: openBuild }),
    [builds.builds, openBuild],
  );
  const [showDetails, setShowDetails] = useState(() => load("detailsVisible") !== "0");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [transient, setTransient] = useState<ReadonlyMap<string, BoxView["status"]>>(new Map());
  const [updates, setUpdates] = useState<Updates | null>(null);
  const [image, setImage] = useState<ImageStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => load("dismissedVersion"));
  const [remotes, setRemotes] = useState<
    { remote: SshRemote; tunnelUp: boolean; tunnelError: string | null }[]
  >([]);
  const filterRef = useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // Derived state

  const all = useMemo(() => withTransient(data.boxes, transient), [data.boxes, transient]);
  const inProject = useMemo(
    () => all.filter((b) => projectId === null || b.box.projectId === projectId),
    [all, projectId],
  );
  const rows = useMemo(() => visibleBoxes(all, projectId, filter), [all, projectId, filter]);
  const selection = useMemo(() => rows.filter((b) => selected.has(b.box.id)), [rows, selected]);
  const single = selection.length === 1 ? (selection[0] as BoxView) : null;
  const states = actionStates(selection, all, tabs.tabs.length);
  const projects = data.projects.map((p) => p.project);
  const currentProject = data.projects.find((p) => p.project.id === projectId);

  useEffect(() => store(projectKey, projectId), [projectKey, projectId]);
  useEffect(() => store("detailsVisible", showDetails ? "1" : "0"), [showDetails]);

  // A project that disappeared falls back to "All projects".
  useEffect(() => {
    if (
      data.loaded &&
      projectId !== null &&
      !data.projects.some((p) => p.project.id === projectId) &&
      data.projects.length > 0
    ) {
      setProjectId(null);
    }
  }, [data.loaded, data.projects, projectId]);

  // The first row is selected when nothing is, as in the Qt table. The update
  // reads the latest selection, not this render's: a click can land before
  // this effect runs, and a stale empty selection would overwrite it.
  useEffect(() => {
    const visible = new Set(rows.map((b) => b.box.id));
    setSelected((prev) => {
      const kept = [...prev].filter((id) => visible.has(id));
      if (kept.length === 0 && rows.length > 0) {
        const first = [...rows].sort(
          (a, b) => Number(b.status === "running") - Number(a.status === "running"),
        )[0];
        return first ? new Set([first.box.id]) : prev;
      }
      return kept.length !== prev.size ? new Set(kept) : prev;
    });
  }, [rows, selected]);

  // -------------------------------------------------------------------------
  // Start-up: updates, image status, setup, and resume after reboot

  const upgradeStatus = useCallback((updates: Updates, image: ImageStatus) => {
    setUpdates(updates);
    setImage(image);
  }, []);

  const loadRemotes = useCallback(() => {
    client
      .call("sshRemotes.list", {})
      .then((r) => setRemotes(r.remotes))
      .catch(() => undefined);
  }, [client]);
  useEffect(loadRemotes, [loadRemotes]);

  const startupDone = useRef(false);
  useEffect(() => {
    // Another machine's view waits until it comes to the front, so its
    // prompts never open behind the view in front.
    if (startupDone.current || !machine.active || !data.loaded || data.error || !data.settings)
      return;
    startupDone.current = true;
    if (!data.settings.setupCompleted) {
      setDialog({ kind: "setup" });
      return;
    }
    const resumable = resumableBoxes(data.boxes);
    if (resumable.length === 0) return;
    void ask({
      title: "Resume boxes?",
      text: "Start them now?",
      detail: resumeDetail(resumable.map((b) => b.box.id)),
      buttons: [
        {
          id: "rebuild",
          label: "Rebuild Image...",
          onClick: () => openFromPrompt({ kind: "setup", stacked: true }),
        },
        { id: "yes", label: "Yes", primary: true },
        { id: "no", label: "No", cancel: true },
      ],
    }).then(async (answer) => {
      if (answer.button !== "yes") return;
      const res = await client
        .call("boxes.startAll", { body: { onlyWasRunning: true } })
        .catch((err: unknown) => {
          void inform("Resume boxes", errorMessage(err));
          return null;
        });
      if (res) reportBulk("Resume boxes", res);
      void data.reload();
    });
    // Runs once, after the first load.
  });

  // Notification clicks from the Electron main process select the box. The
  // main process raises the notifications of this PC's server. A remote view
  // raises its own, through the bridge, and names its machine in the click.
  const activateRef = useRef(machine.activate);
  activateRef.current = machine.activate;
  const machineId = machine.id;
  useEffect(
    () =>
      bridge()?.onSelectBox((boxId, from, notificationId) => {
        if ((from ?? LOCAL_MACHINE_ID) !== machineId) return;
        if (notificationId) {
          void client
            .call("notifications.read", { params: { notificationId } })
            .catch(() => undefined);
        }
        // An open dialog is modal: its view stays in front until the user
        // answers it, and this view shows the box after that.
        if (!hasOpenDialog()) activateRef.current();
        setPage("boxes");
        setProjectId(null);
        setFilter("");
        setSelected(new Set([boxId]));
      }),
    [machineId, client],
  );

  // A remote machine's boxes raise desktop notifications through the bridge,
  // as this PC's boxes do through the main process. The main process also
  // watches the server this app connects to, so the primary view never
  // notifies, even when that server is an enrolled hub and not this PC.
  useEvent("notification", (ev) => {
    if (machine.id === LOCAL_MACHINE_ID || !ev.boxId) return;
    if (ev.kind !== "box_ended" && ev.runId !== null) return;
    bridge()?.notify?.({
      title: ev.title,
      body: ev.body,
      urgent: ev.severity === "error",
      boxId: ev.boxId,
      machineId: machine.id,
      notificationId: ev.notificationId,
    });
  });

  // -------------------------------------------------------------------------
  // Helpers

  const mark = (ids: string[], status: BoxView["status"] | null) =>
    setTransient((t) => {
      const next = new Map(t);
      for (const id of ids) {
        if (status) next.set(id, status);
        else next.delete(id);
      }
      return next;
    });

  // Tab titles follow the conversation name, which /rename changes.
  useEffect(() => {
    const names = new Map(data.boxes.map((b) => [b.box.id, displayName(b)]));
    setTabs((t) => syncTitles(t, names, (p) => platformLabel[p]));
  }, [data.boxes]);

  useEvent("box.changed", (ev) => setTransient((t) => settleTransient(t, ev.boxId, ev.status)));

  const openTerminal = (view: BoxView) =>
    setTabs((t) =>
      openTab(t, { boxId: view.box.id, title: displayName(view), tooltip: view.box.id }),
    );

  const openLink = (url: string) => {
    // A loopback link from another machine names that machine, but this PC
    // would open it on itself, and the hub doesn't carry dev-server traffic.
    if (!machine.isLocal && isLoopbackUrl(url)) {
      void inform(
        "Open Link",
        `This link points to a loopback address on ${machine.name}, which this PC can't reach. Open it on ${machine.name}.`,
        url,
      );
      return;
    }
    const b = bridge();
    if (!b) {
      window.open(url, "_blank", "noopener");
      return;
    }
    void b
      .openExternal(url)
      .then((r) => {
        if (!r.ok) void inform("Open Link", r.error ?? `${url} didn't open.`);
      })
      .catch((err: unknown) => void inform("Open Link", errorMessage(err)));
  };

  const reportBulk = (
    title: string,
    res: { done: string[]; failed: { boxId: string; error: { message: string } }[] },
  ) => {
    if (res.failed.length > 0) {
      void inform(
        title,
        `${res.failed.length} of ${res.done.length + res.failed.length} failed.`,
        res.failed.map((f) => `${f.boxId}: ${f.error.message}`).join("\n"),
      );
    }
  };

  /**
   * Opens a dialog that a message box button asked for. The message box can
   * come from a hidden view, so that view comes to the front with its dialog.
   */
  const openFromPrompt = (next: DialogState) => {
    activateRef.current();
    setDialog(next);
  };

  /**
   * Shows a launch error, with the follow-up each code needs. Returns true to
   * retry, "force" to retry a start despite stale mounts (only when
   * `canForce`), and false to give up.
   */
  const handleLaunchError = async (
    title: string,
    err: unknown,
    view?: BoxView,
    canForce = false,
  ): Promise<boolean | "force"> => {
    if (isApiError(err, "stale_mounts") && view) {
      const answer = await ask({
        title,
        text: `The mounts, ports, or secrets of the project container for ${view.box.id} changed.`,
        detail: canForce
          ? "The container keeps its old settings until it restarts. Restart it now? Running boxes in it restart and resume their conversations. Start Anyway starts this box in the container as it is, without the changes."
          : "The container keeps its old settings until it restarts. Restart it now? Running boxes in it restart and resume their conversations.",
        buttons: [
          { id: "yes", label: "Restart Container", primary: true },
          ...(canForce ? [{ id: "force", label: "Start Anyway" }] : []),
          { id: "no", label: "Cancel", cancel: true },
        ],
      });
      if (answer.button === "force") return "force";
      if (answer.button !== "yes") return false;
      try {
        reportBulk(
          title,
          await client.call("projects.restartContainer", {
            params: { projectId: view.box.projectId },
          }),
        );
        return true;
      } catch (e) {
        void inform(title, errorMessage(e));
        return false;
      }
    }
    if (isApiError(err, "engine_mismatch", "image_missing")) {
      const answer = await ask({
        title,
        text: errorMessage(err),
        buttons: [
          { id: "setup", label: "Rebuild Image...", primary: true },
          { id: "ok", label: "Close", cancel: true },
        ],
      });
      if (answer.button === "setup") openFromPrompt({ kind: "setup" });
      return false;
    }
    await inform(title, errorMessage(err));
    return false;
  };

  // -------------------------------------------------------------------------
  // Box actions

  /**
   * Starts a box, and retries after the user restarts a stale container or
   * picks Start Anyway. Returns the started box, or null when it didn't start.
   */
  const startBox = async (
    view: BoxView,
    openTab = true,
    title = "Start",
  ): Promise<BoxView | null> => {
    mark([view.box.id], "starting");
    try {
      let force = false;
      for (;;) {
        try {
          const v = await client.call("boxes.start", {
            params: { boxId: view.box.id },
            ...(force ? { body: { force: true } } : {}),
          });
          data.putBox(v);
          if (openTab) openTerminal(v);
          return v;
        } catch (err) {
          const next = await handleLaunchError(title, err, view, true);
          if (!next) return null;
          force = next === "force";
        }
      }
    } finally {
      mark([view.box.id], null);
    }
  };

  const onStart = (boxes: readonly BoxView[]) => {
    const targets = boxes.filter((b) => b.status === "stopped");
    for (const b of targets) void startBox(b);
  };

  const onStop = async (boxes: readonly BoxView[]) => {
    const targets = boxes.filter((b) => b.status === "running");
    mark(
      targets.map((b) => b.box.id),
      "stopping",
    );
    await Promise.all(
      targets.map(async (b) => {
        try {
          data.putBox(await client.call("boxes.stop", { params: { boxId: b.box.id } }));
          setTabs((t) => closeBoxTabs(t, b.box.id));
        } catch (err) {
          void inform("Stop", `${b.box.id}: ${errorMessage(err)}`);
        }
      }),
    );
    mark(
      targets.map((b) => b.box.id),
      null,
    );
  };

  const onStopAll = async () => {
    const running = all.filter((b) => b.status === "running");
    if (running.length === 0) return;
    if (!(await confirm("Stop All", `Stop ${running.length} running box(es)?`))) return;
    mark(
      running.map((b) => b.box.id),
      "stopping",
    );
    try {
      const res = await client.call("boxes.stopAll", {});
      for (const id of res.done) setTabs((t) => closeBoxTabs(t, id));
      reportBulk("Stop All", res);
    } catch (err) {
      void inform("Stop All", errorMessage(err));
    } finally {
      mark(
        running.map((b) => b.box.id),
        null,
      );
      void data.reload();
    }
  };

  const onStartAllStopped = async () => {
    try {
      const res = await client.call("boxes.startAll", { body: { onlyWasRunning: true } });
      reportBulk("Start All Stopped", res);
      void data.reload();
      // `data.boxes` is this render's list, from before the boxes started.
      const { boxes } = await client.call("boxes.list", {});
      for (const id of res.done) {
        const v = boxes.find((b) => b.box.id === id);
        if (v) openTerminal(v);
      }
    } catch (err) {
      await handleLaunchError("Start All Stopped", err);
    }
  };

  const onRestartAll = async () => {
    const running = all.filter((b) => b.status === "running");
    if (running.length === 0) return;
    const answer = await ask({
      title: "Restart All",
      text: `Restart ${running.length} running box(es)?`,
      detail: `Each conversation resumes where it left off.\n\n  ${running.map((b) => b.box.id).join("\n  ")}`,
      buttons: [
        {
          id: "rebuild",
          label: "Rebuild Image...",
          onClick: () => openFromPrompt({ kind: "setup", stacked: true }),
        },
        { id: "yes", label: "Yes", primary: true },
        { id: "no", label: "No", cancel: true },
      ],
    });
    if (answer.button !== "yes") return;
    mark(
      running.map((b) => b.box.id),
      "stopping",
    );
    try {
      const res = await client.call("boxes.restartAll", {});
      reportBulk("Restart All", res);
      setTabs((t) => {
        let s = t;
        for (const id of res.done) {
          const old = s.tabs.find((x) => x.boxId === id && x.kind === "session");
          s = closeBoxTabs(s, id);
          if (old) s = openTab(s, { boxId: id, title: old.title, tooltip: old.tooltip });
        }
        return s;
      });
    } catch (err) {
      await handleLaunchError("Restart All", err);
    } finally {
      mark(
        running.map((b) => b.box.id),
        null,
      );
      void data.reload();
    }
  };

  const attachLabel = (view: BoxView | null) =>
    view ? `Attach to ${platformLabel[view.box.platform]} Session` : "Attach to Session";

  const externalTerminal = async (
    view: BoxView,
    kind: "session" | "shell" | "side",
    platform?: Platform,
  ) => {
    const title = kind === "shell" ? "Open Shell in Container" : attachLabel(view);
    if (!machine.isLocal) {
      // A host terminal here can't reach a container on another PC, so the
      // terminal opens in a tab, through the hub.
      // The tabs sit on the Boxes page, so show it: on the Usage page the
      // terminal would open out of sight.
      setPage("boxes");
      if (kind === "shell")
        setTabs((t) =>
          openTab(t, { boxId: view.box.id, kind, title: `${displayName(view)} (shell)` }),
        );
      else if (kind === "side" && platform)
        setTabs((t) =>
          openTab(t, {
            boxId: view.box.id,
            kind,
            platform,
            title: `${displayName(view)} (${platformLabel[platform]})`,
          }),
        );
      else openTerminal(view);
      return;
    }
    const b = bridge();
    if (b) {
      const r = await b.openExternalTerminal({
        boxId: view.box.id,
        kind,
        ...(platform ? { platform } : {}),
      });
      if (!r.ok) void inform(title, r.error ?? "The terminal didn't start.");
      return;
    }
    // In a plain browser, show the command to paste into a terminal.
    try {
      const { argv } = await client.call("boxes.attachCommand", {
        params: { boxId: view.box.id },
        query: { kind, ...(platform ? { platform } : {}) },
      });
      const command = argv
        .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))
        .join(" ");
      await navigator.clipboard?.writeText(command).catch(() => undefined);
      void inform(title, "Run this command in a terminal. It is on the clipboard.", command);
    } catch (err) {
      void inform(title, errorMessage(err));
    }
  };

  const onRemove = async (boxes: readonly BoxView[]) => {
    const targets = boxes.filter((b) => b.status === "stopped");
    if (targets.length === 0) return;
    const text =
      targets.length === 1
        ? `Remove "${targets[0]?.box.id}" from the dashboard?\n\nThe conversation data is kept; use Purge to delete it.`
        : `Remove ${targets.length} boxes from the dashboard?\n\nThe conversation data is kept; use Purge to delete it.`;
    if (!(await confirm("Remove", text))) return;
    for (const b of targets) {
      let removeWorktree = false;
      if (b.box.worktree) {
        removeWorktree = await confirm(
          "Remove",
          `Also delete the git worktree for "${b.box.conversationName}"?\n\n${b.box.worktree}\nbranch ${b.box.branch ?? ""}\n\nIt is deleted only if it has no uncommitted changes and its branch has no commits that exist nowhere else.`,
          undefined,
          true,
        );
      }
      try {
        const res = await client.call("boxes.remove", {
          params: { boxId: b.box.id },
          query: { removeWorktree: removeWorktree ? "true" : "false" },
        });
        setTabs((t) => closeBoxTabs(t, b.box.id));
        if (res.worktree === "refused")
          void inform(
            "Remove",
            `The worktree was kept: ${res.reason ?? "it has work that exists nowhere else."}`,
          );
      } catch (err) {
        void inform("Remove", `${b.box.id}: ${errorMessage(err)}`);
      }
    }
    void data.reload();
  };

  const onPurge = async (single: BoxView) => {
    const dir = single.box.targetDir;
    const running = runningOnDir(all, dir);
    if (running) {
      void inform("Purge", `${running.box.id} is running against this directory. Stop it first.`);
      return;
    }
    let preview;
    try {
      preview = await client.call("boxes.purge", {
        params: { boxId: single.box.id },
        body: { dryRun: true },
      });
    } catch (err) {
      void inform("Purge", errorMessage(err));
      return;
    }
    const list = purgePreviewList(preview);
    if (list.length === 0) {
      void inform("Purge", `There is nothing to purge for ${dir}.`);
      return;
    }
    const ok = await confirm(
      "Purge",
      `This will remove:\n\n${list.join("\n")}\n\nThe directory's own contents (${dir}), including any worktrees, are not touched.\n\nProceed?`,
    );
    if (!ok) return;
    try {
      const res = await client.call("boxes.purge", {
        params: { boxId: single.box.id },
        body: { dryRun: false },
      });
      for (const id of res.removedRecords) setTabs((t) => closeBoxTabs(t, id));
      toast(
        `Purged ${res.removedRecords.length} record(s) and ${res.removedTranscriptDirs.length} transcript folder(s).`,
        { kind: "success" },
      );
    } catch (err) {
      void inform("Purge", errorMessage(err));
    }
    void data.reload();
  };

  const onConvert = async (single: BoxView) => {
    let plan;
    try {
      plan = await client.call("boxes.convertToWorktree.plan", {
        params: { boxId: single.box.id },
      });
    } catch (err) {
      void inform("Convert to Worktree", errorMessage(err));
      return;
    }
    const answer = await ask({
      title: "Convert to Worktree",
      text: `Convert "${single.box.conversationName}" to a git worktree?`,
      detail: plan.report,
      checkbox: {
        label: `Also copy build output (${formatBytes(plan.buildOutputBytes)})`,
        checked: false,
      },
      buttons: [
        { id: "yes", label: "Convert", primary: true },
        { id: "cancel", label: "Cancel", cancel: true },
      ],
    });
    if (answer.button !== "yes") return;
    try {
      const job = await client.call("boxes.convertToWorktree", {
        params: { boxId: single.box.id },
        body: { copyBuildOutput: answer.checked },
      });
      setDialog({
        kind: "job",
        title: "Convert to Worktree",
        job,
        onDone: () => void data.reload(),
        renderResult: (j: Job) => <ConvertReport job={j} />,
      });
    } catch (err) {
      void inform("Convert to Worktree", errorMessage(err));
    }
  };

  const onStartReview = async (single: BoxView) => {
    // The run executes on the machine that holds the box; the review app
    // reaches it through this server.
    const machineId = machine.isLocal ? undefined : machine.id;
    const b = bridge();
    if (b) {
      const r = await b.launchReview({
        projectId: single.box.projectId,
        boxId: single.box.id,
        ...(machineId ? { machineId } : {}),
      });
      if (!r.ok) void inform("Start Review", r.error ?? "The review app didn't start.");
    } else {
      const q = new URLSearchParams({ project: single.box.projectId, box: single.box.id });
      if (machineId) q.set("machine", machineId);
      window.open(`/review/?${q.toString()}`, "_blank");
    }
  };

  const startSide = async (view: BoxView, p: Platform) => {
    try {
      const { session } = await client.call("boxes.sideSessions.start", {
        params: { boxId: view.box.id },
        body: { platform: p },
      });
      toast(
        `${platformLabel[p]} started in remote mode in ${view.box.id} (tmux session ${session}).`,
        { kind: "success" },
      );
      data.putBox({ ...view, sideSessions: [...view.sideSessions, p] });
    } catch (err) {
      void inform(
        "Start Remote Session",
        `Could not start ${platformLabel[p]} in ${view.box.id}:\n${errorMessage(err)}`,
      );
    }
  };

  const stopSide = async (view: BoxView, p: Platform) => {
    try {
      await client.call("boxes.sideSessions.stop", { params: { boxId: view.box.id, platform: p } });
      data.putBox({ ...view, sideSessions: view.sideSessions.filter((x) => x !== p) });
      setTabs((t) => {
        const tab = t.tabs.find(
          (x) => x.boxId === view.box.id && x.kind === "side" && x.platform === p,
        );
        return tab ? closeTab(t, tab.key) : t;
      });
    } catch (err) {
      void inform("Stop Remote Session", errorMessage(err));
    }
  };

  const setPlatform = async (view: BoxView, p: Platform) => {
    const running = view.status === "running";
    const restart =
      running &&
      (await confirm(
        "Main Platform",
        `${view.box.id} is running. Restart it now to switch to ${platformLabel[p]}?`,
      ));
    try {
      const v = await client.call("boxes.platform", {
        params: { boxId: view.box.id },
        body: { platform: p, restart },
      });
      data.putBox(v);
      if (restart) {
        setTabs((t) => closeBoxTabs(t, view.box.id));
        openTerminal(v);
      }
    } catch (err) {
      void inform("Main Platform", errorMessage(err));
    }
  };

  // -------------------------------------------------------------------------
  // New, edit, and fork

  /** Saves project settings edited in the box dialog; returns an error or null. */
  const saveProjectSettings = async (
    dir: string,
    project: ProjectEdits | null,
  ): Promise<string | null> => {
    if (!project) return null;
    // A box created just now may have created the project on the server.
    let p =
      projectForDir(projects, dir) ??
      projectForDir(
        (await client.call("projects.list", {})).projects.map((x) => x.project),
        dir,
      );
    if (!p) p = await client.call("projects.create", { body: { root: normalizeDir(dir) } });
    const res = await client.call("projects.update", {
      params: { projectId: p.id },
      body: project,
    });
    if (res.staleBoxes.length > 0) {
      const summary = data.projects.find((x) => x.project.id === p.id) ?? null;
      await offerContainerRestart(p.id, res.staleBoxes, summary);
    }
    return null;
  };

  /** The Qt `confirmSharedMounts`: offer to restart a container whose settings went stale. */
  const offerContainerRestart = async (
    projectIdToRestart: string,
    stale: string[],
    summary: ProjectSummary | null,
  ) => {
    const ok = await confirm(
      "Project settings",
      `The project's container keeps its old mounts and ports until it restarts. Restart ${
        summary ? `"${summary.project.name}"` : "it"
      } now?`,
      `These boxes restart and resume their conversations:\n\n  ${stale.join("\n  ")}`,
    );
    if (!ok) return;
    try {
      reportBulk(
        "Project settings",
        await client.call("projects.restartContainer", {
          params: { projectId: projectIdToRestart },
        }),
      );
    } catch (err) {
      await handleLaunchError("Project settings", err);
    }
  };

  /** Asks about a session another box tracks. Returns true to retry with `force`. */
  const adoptionAnswer = async (title: string, err: unknown): Promise<"force" | string | null> => {
    if (isApiError(err, "adoption_refused")) {
      return `${err.message}\n\nTwo boxes resuming the same session would write over each other's transcript. Stop that box first, or pick another conversation.`;
    }
    if (isApiError(err, "session_tracked")) {
      const holders = (err.details as { holders?: string[] } | undefined)?.holders ?? [];
      const ok = await confirm(
        title,
        `Box ${holders.join(", ") || "another box"} already tracks this conversation.\n\nCreating another box for it is fine as long as they don't run at the same time.\n\nProceed?`,
      );
      return ok ? "force" : "";
    }
    return null;
  };

  const runCreate = async (
    title: string,
    form: BoxForm,
    mode: "new" | "fork",
    forkFrom: string | undefined,
    project: ProjectEdits | null,
  ): Promise<string | null> => {
    // Project settings edited in the dialog are saved only once the server
    // has accepted the box, so a refused create leaves the project as it
    // was. The box then starts after them, so it gets the new mounts.
    const deferStart = project !== null;
    let force = false;
    for (;;) {
      try {
        const job = await client.call("boxes.create", {
          body: createBody(form, mode, {
            ...(forkFrom ? { forkFrom } : {}),
            force,
            start: !deferStart,
          }),
        });
        setDialog(null);
        toast(`Creating ${form.name || form.targetDir}...`);
        void waitForJob(() => client.call("jobs.get", { params: { jobId: job.id } }), {
          intervalMs: 700,
        })
          .then(async (done) => {
            const message = createJobMessage(done, deferStart);
            if (message !== null) {
              if (done.status === "running") void data.reload();
              void inform(title, message);
              return;
            }
            const id = (done.result as { box?: { id: string } } | null)?.box?.id ?? done.boxId;
            let v = id
              ? await client.call("boxes.get", { params: { boxId: id } }).catch(() => null)
              : null;
            if (deferStart) {
              let settingsError: string | null;
              try {
                settingsError = await saveProjectSettings(
                  v?.box.targetDir ?? form.targetDir,
                  project,
                );
              } catch (err) {
                settingsError = errorMessage(err);
              }
              const name = v?.box.id ?? id ?? (form.name || form.targetDir);
              if (settingsError !== null) {
                // Starting now would give the box the old mounts and ports.
                void inform(
                  title,
                  `Created ${name}, but saving the project settings failed: ${settingsError}\n\nThe box is stopped. Edit the project settings again, then start the box.`,
                );
              } else if (!v) {
                void inform(
                  title,
                  `Created ${name}, but the app couldn't load it to start it. The box is stopped; start it from the list.`,
                );
              } else {
                v = (await startBox(v, false, title)) ?? v;
              }
            }
            await data.reload();
            if (v) {
              data.putBox(v);
              setSelected(new Set([v.box.id]));
              if (v.status === "running") openTerminal(v);
            }
          })
          .catch((err: unknown) => void inform(title, errorMessage(err)));
        return null;
      } catch (err) {
        const a = await adoptionAnswer(title, err);
        if (a === "force") {
          force = true;
          continue;
        }
        if (a !== null) return a || "Pick another conversation.";
        if (
          isApiError(
            err,
            "stale_mounts",
            "engine_mismatch",
            "image_missing",
            "secrets_locked",
            "secrets_unavailable",
          )
        ) {
          setDialog(null);
          await handleLaunchError(title, err);
          return null;
        }
        return errorMessage(err);
      }
    }
  };

  const acceptNew = (r: BoxDialogResult) =>
    runCreate("New Box", r.form, "new", undefined, projectEdits(r));

  const acceptFork = (source: BoxView) => (r: BoxDialogResult) =>
    runCreate("Fork Conversation", r.form, "fork", source.box.id, projectEdits(r));

  const acceptEdit = (view: BoxView) => async (r: BoxDialogResult) => {
    // The box update goes first, so a refused update leaves the project as it
    // was and a second Save doesn't save it (or offer its restart) again.
    const body = updateBody(view.box, r.form, r.handPicked);
    let restartRequired = false;
    if (Object.keys(body).length > 0) {
      let force = false;
      for (;;) {
        try {
          const res = await client.call("boxes.update", {
            params: { boxId: view.box.id },
            body: { ...body, ...(force ? { force } : {}) },
          });
          data.putBox(res.box);
          restartRequired = res.restartRequired;
          break;
        } catch (err) {
          const a = await adoptionAnswer("Edit Box", err);
          if (a === "force") {
            force = true;
            continue;
          }
          if (a !== null) return a || "Pick another conversation.";
          return errorMessage(err);
        }
      }
    }
    setDialog(null);
    try {
      await saveProjectSettings(view.box.targetDir, projectEdits(r));
    } catch (err) {
      void inform("Edit Box", `Saving the project settings failed: ${errorMessage(err)}`);
    }
    if (restartRequired) {
      const restart = await confirm(
        "Edit Box",
        `${view.box.id} is running, and the model, effort, permission flag, SSH remotes, or linked conversation of a live session can't change. They take effect the next time it starts.\n\nRestart it now to apply them?`,
      );
      if (restart) {
        setTabs((t) => closeBoxTabs(t, view.box.id));
        try {
          const v = await client.call("boxes.restart", { params: { boxId: view.box.id } });
          data.putBox(v);
          openTerminal(v);
        } catch (err) {
          // A restart is a stop and then a start: when the start fails, the
          // box is stopped, so start it with the usual retry and Start Anyway.
          if (isApiError(err, "stale_mounts")) await startBox(view, true, "Edit Box");
          else await handleLaunchError("Edit Box", err, view);
        }
      }
    }
    if (Object.keys(body).length > 0) loadRemotes();
    return null;
  };

  // -------------------------------------------------------------------------
  // Settings, updates, and help

  const rebuildImage = async (stacked = false) => {
    try {
      const job = await client.call("image.build", { body: { kind: "claude-code" } });
      setDialog({
        kind: "job",
        title: "Update Claude Code",
        job,
        stacked,
        onDone: () => {
          client
            .call("updates.check", { query: { force: "true" } })
            .then(setUpdates)
            .catch(() => undefined);
          client
            .call("image.status", {})
            .then(setImage)
            .catch(() => undefined);
        },
      });
    } catch (err) {
      void inform("Rebuild image", errorMessage(err));
    }
  };

  const checkUpdates = async (which: "app" | "claudeCode") => {
    try {
      const u = await client.call("updates.check", { query: { force: "true" } });
      setUpdates(u);
      if (which === "app") {
        if (!u.app.updateAvailable)
          void inform("Check for Updates", `AI Orchestrator ${u.app.current} is up to date.`);
        else {
          setDismissed(null);
          store("dismissedVersion", null);
        }
      } else if (!u.claudeCode.stale) {
        void inform(
          "Check for Claude Code Update",
          `The image has the newest Claude Code (${u.claudeCode.image ?? "unknown"}).`,
        );
      }
    } catch (err) {
      void inform("Check for Updates", errorMessage(err));
    }
  };

  const about = () =>
    inform(
      "About AI Orchestrator",
      "AI Orchestrator runs Claude Code, Codex, and GitHub Copilot in sandboxed containers, one per project, with one tmux session per box.\n\nStop ends a box's session. A project's container stops by itself once no session runs in it.",
    );

  // -------------------------------------------------------------------------
  // Projects

  const projectMenu = (p: ProjectSummary): MenuEntry[] => [
    {
      label: "New Box Here...",
      chord: CHORDS.newBox,
      run: () => setDialog({ kind: "new", dir: p.project.root }),
    },
    { type: "separator" },
    { label: "Rename project...", run: () => setDialog({ kind: "renameProject", project: p }) },
    {
      label: "Open folder",
      run: () => {
        const b = machine.isLocal ? bridge() : undefined;
        if (b)
          void b
            .openPath(p.project.root)
            .then((r) => !r.ok && void inform("Open folder", r.error ?? ""));
        else {
          void navigator.clipboard?.writeText(p.project.root).catch(() => undefined);
          toast(
            machine.isLocal
              ? `${p.project.root} is on the clipboard.`
              : `${p.project.root} on ${machine.name} is on the clipboard.`,
          );
        }
      },
    },
    {
      label: "Project mounts and ports...",
      run: () => setDialog({ kind: "projectSettings", project: p }),
    },
    {
      label: "Restart project container...",
      enabled: p.running > 0,
      run: async () => {
        if (
          !(await confirm(
            "Restart container",
            `Restart the container of "${p.project.name}" and the ${p.running} running box(es) in it?`,
          ))
        )
          return;
        try {
          reportBulk(
            "Restart container",
            await client.call("projects.restartContainer", { params: { projectId: p.project.id } }),
          );
        } catch (err) {
          await handleLaunchError("Restart container", err);
        }
        void data.reload();
      },
    },
  ];

  // -------------------------------------------------------------------------
  // Actions, menus, toolbar, and chords

  const newDir = () => currentProject?.project.root ?? data.settings?.defaultTargetDir ?? "";
  const boxActions = (targets: readonly BoxView[]) => {
    const target = targets.length === 1 ? targets[0] : undefined;
    return {
      edit: () => target && setDialog({ kind: "edit", box: target }),
      fork: () => target && setDialog({ kind: "fork", box: target }),
      convert: () => target && void onConvert(target),
      start: () => onStart(targets),
      stop: () => void onStop(targets),
      attach: () => target && void externalTerminal(target, "session"),
      openShell: () => target && void externalTerminal(target, "shell"),
      remove: () => void onRemove(targets),
      purge: () => target && void onPurge(target),
      move: () => target && setDialog({ kind: "move", box: target }),
      changeDir: () =>
        target && setDialog({ kind: "changeDir", box: target, title: "Change Working Directory" }),
      review: () => target && void onStartReview(target),
    };
  };

  const run = {
    newBox: () => setDialog({ kind: "new", dir: newDir() }),
    setup: () => setDialog({ kind: "setup" }),
    sshRemotes: () => setDialog({ kind: "sshRemotes" }),
    prompts: () => setDialog({ kind: "prompts" }),
    globalMounts: () => setDialog({ kind: "globalMounts" }),
    machines: () => machine.openMachines?.(),
    quit: () => {
      const b = bridge();
      if (b) b.quit();
      else window.close();
    },
    ...boxActions(selection),
    stopAll: () => void onStopAll(),
    startAllStopped: () => void onStartAllStopped(),
    restartAll: () => void onRestartAll(),
    refresh: () => {
      void client.call("stats.refresh", {}).catch(() => undefined);
      void data.reload();
      loadRemotes();
    },
    details: () => setShowDetails((v) => !v),
    filter: () => {
      setPage("boxes");
      filterRef.current?.focus();
      filterRef.current?.select();
    },
    closeTab: () => tabs.current && setTabs((t) => (t.current ? closeTab(t, t.current) : t)),
    nextTab: () => setTabs((t) => stepTab(t, 1)),
    prevTab: () => setTabs((t) => stepTab(t, -1)),
  };

  const bindings: ChordBinding[] = [
    { chord: CHORDS.newBox, run: run.newBox },
    { chord: CHORDS.sshRemotes, run: run.sshRemotes },
    { chord: CHORDS.edit, run: run.edit, enabled: states.edit },
    { chord: CHORDS.fork, run: run.fork, enabled: states.fork },
    { chord: CHORDS.start, run: run.start, enabled: states.start },
    { chord: CHORDS.stopAll, run: run.stopAll, enabled: states.stopAll },
    { chord: CHORDS.startAllStopped, run: run.startAllStopped, enabled: states.startAllStopped },
    { chord: CHORDS.openShell, run: run.openShell, enabled: states.openShell },
    { chord: CHORDS.attach, run: run.attach, enabled: states.attach },
    { chord: CHORDS.refresh, run: run.refresh },
    { chord: CHORDS.details, run: run.details },
    { chord: CHORDS.closeTab, run: run.closeTab, enabled: states.closeTab },
    { chord: CHORDS.filter, run: run.filter },
    { chord: CHORDS.nextTab, run: run.nextTab },
    { chord: CHORDS.prevTab, run: run.prevTab },
    { chord: CHORDS.quit, run: run.quit },
    ...(machine.openMachines ? [{ chord: CHORDS.machines, run: run.machines }] : []),
    ...Array.from({ length: 9 }, (_, i) => ({
      chord: `Alt+${i + 1}`,
      run: () => {
        setPage("boxes");
        setTabs((t) => pickTab(t, i + 1));
      },
    })),
  ];
  useChords(machine.active && dialog === null && !messageOpen ? bindings : []);

  const sideMenus = (view: BoxView): MenuEntry[] => {
    const running = view.status === "running";
    const startable = PLATFORMS.filter(
      (p) => p !== view.box.platform && !view.sideSessions.includes(p),
    );
    return [
      {
        label: "Start Remote Session",
        enabled: running && startable.length > 0,
        submenu: startable.map((p) => ({
          label: platformLabel[p],
          run: () => void startSide(view, p),
        })),
      },
      {
        label: "Open Remote Session",
        enabled: running && view.sideSessions.length > 0,
        submenu: view.sideSessions.map((p) => ({
          label: platformLabel[p],
          run: () =>
            setTabs((t) =>
              openTab(t, {
                boxId: view.box.id,
                kind: "side",
                platform: p,
                title: `${displayName(view)} (${platformLabel[p]})`,
              }),
            ),
        })),
      },
      {
        label: "Stop Remote Session",
        enabled: view.sideSessions.length > 0,
        submenu: view.sideSessions.map((p) => ({
          label: platformLabel[p],
          run: () => void stopSide(view, p),
        })),
      },
      {
        label: "Main Platform",
        submenu: PLATFORMS.map((p) => ({
          label: platformLabel[p],
          checked: p === view.box.platform,
          run: p === view.box.platform ? undefined : () => void setPlatform(view, p),
        })),
      },
    ];
  };

  const boxMenu = (view: BoxView | null): MenuEntry[] => {
    // The table selects an unselected row when you open its context menu.
    const targets = view && !selected.has(view.box.id) ? [view] : selection;
    const target = targets.length === 1 ? (targets[0] ?? null) : null;
    const states = actionStates(targets, all, tabs.tabs.length);
    const run = boxActions(targets);
    return [
      { label: "Start", chord: CHORDS.start, enabled: states.start, run: run.start },
      { label: "Edit Box...", chord: CHORDS.edit, enabled: states.edit, run: run.edit },
      { label: "Fork Conversation...", chord: CHORDS.fork, enabled: states.fork, run: run.fork },
      { label: "Convert to Worktree...", enabled: states.convertToWorktree, run: run.convert },
      { label: "Start Review...", enabled: states.startReview, run: run.review },
      ...(view && target ? [{ type: "separator" } as const, ...sideMenus(target)] : []),
      { type: "separator" },
      { label: "Stop", enabled: states.stop, run: run.stop },
      {
        label: attachLabel(target),
        chord: CHORDS.attach,
        enabled: states.attach,
        run: run.attach,
      },
      {
        label: "Open Shell in Container",
        chord: CHORDS.openShell,
        enabled: states.openShell,
        run: run.openShell,
      },
      { type: "separator" },
      { label: "Move Working Directory...", enabled: states.moveWorkDir, run: run.move },
      { label: "Change Working Directory...", enabled: states.changeWorkDir, run: run.changeDir },
      { type: "separator" },
      { label: "Remove", enabled: states.remove, run: run.remove },
      { label: "Purge...", enabled: states.purge, run: run.purge },
    ];
  };

  const menus = [
    {
      label: "File",
      entries: [
        { label: "New Box...", chord: CHORDS.newBox, run: run.newBox },
        { label: "Setup...", run: run.setup },
        { label: "Manage SSH Remotes...", chord: CHORDS.sshRemotes, run: run.sshRemotes },
        { label: "Edit Prompts...", run: run.prompts },
        { label: "Global Mounts...", run: run.globalMounts },
        ...(machine.openMachines
          ? [{ label: "Machines...", chord: CHORDS.machines, run: run.machines }]
          : []),
        { type: "separator" },
        { label: "Quit", chord: CHORDS.quit, run: run.quit },
      ] as MenuEntry[],
    },
    {
      label: "Box",
      entries: [
        { label: "Start", chord: CHORDS.start, enabled: states.start, run: run.start },
        { label: "Edit Box...", chord: CHORDS.edit, enabled: states.edit, run: run.edit },
        { label: "Fork Conversation...", chord: CHORDS.fork, enabled: states.fork, run: run.fork },
        { label: "Convert to Worktree...", enabled: states.convertToWorktree, run: run.convert },
        { label: "Start Review...", enabled: states.startReview, run: run.review },
        { type: "separator" },
        { label: "Stop", enabled: states.stop, run: run.stop },
        {
          label: "Stop All Running",
          chord: CHORDS.stopAll,
          enabled: states.stopAll,
          run: run.stopAll,
        },
        {
          label: "Start All Stopped",
          chord: CHORDS.startAllStopped,
          enabled: states.startAllStopped,
          run: run.startAllStopped,
        },
        { label: "Restart All Running...", enabled: states.restartAll, run: run.restartAll },
        {
          label: attachLabel(single),
          chord: CHORDS.attach,
          enabled: states.attach,
          run: run.attach,
        },
        {
          label: "Open Shell in Container",
          chord: CHORDS.openShell,
          enabled: states.openShell,
          run: run.openShell,
        },
        { type: "separator" },
        { label: "Move Working Directory...", enabled: states.moveWorkDir, run: run.move },
        { label: "Change Working Directory...", enabled: states.changeWorkDir, run: run.changeDir },
        { type: "separator" },
        { label: "Remove", enabled: states.remove, run: run.remove },
        { label: "Purge...", enabled: states.purge, run: run.purge },
      ] as MenuEntry[],
    },
    {
      label: "View",
      entries: [
        { label: "Refresh Now", chord: CHORDS.refresh, run: run.refresh },
        { type: "separator" },
        {
          label: "Show Details Panel",
          chord: CHORDS.details,
          checked: showDetails,
          run: run.details,
        },
        { label: "Filter Boxes", chord: CHORDS.filter, run: run.filter },
      ] as MenuEntry[],
    },
    {
      label: "Terminal",
      entries: [
        { label: "Close Tab", chord: CHORDS.closeTab, enabled: states.closeTab, run: run.closeTab },
        {
          label: "Next Tab",
          chord: CHORDS.nextTab,
          enabled: tabs.tabs.length > 1,
          run: run.nextTab,
        },
        {
          label: "Previous Tab",
          chord: CHORDS.prevTab,
          enabled: tabs.tabs.length > 1,
          run: run.prevTab,
        },
      ] as MenuEntry[],
    },
    {
      label: "Help",
      entries: [
        { label: "Check for Updates", run: () => void checkUpdates("app") },
        { label: "Check for Claude Code Update", run: () => void checkUpdates("claudeCode") },
        { type: "separator" },
        { label: "About", run: () => void about() },
      ] as MenuEntry[],
    },
  ];

  const tool = (label: string, enabled: boolean, onClick: () => void, title?: string) => (
    <button type="button" className="ab-tool" disabled={!enabled} onClick={onClick} title={title}>
      {label}
    </button>
  );

  // -------------------------------------------------------------------------
  // Render

  const serverError =
    data.error && data.error.code !== "docker_unavailable"
      ? data.error.code === "machine_offline"
        ? `${machine.name} is offline: the hub can't reach it. ${data.error.message}`
        : data.error.code === "machine_timeout"
          ? `${machine.name} timed out: it didn't answer the hub in time. ${data.error.message}`
          : data.error.code === "unreachable"
            ? machine.isLocal
              ? `The AI Orchestrator server is not reachable. Check that aio-server runs (systemctl --user status aio-server). ${data.error.message}`
              : `This PC's AI Orchestrator server, which relays ${machine.name}, is not reachable. Check that aio-server runs (systemctl --user status aio-server). ${data.error.message}`
            : data.error.message
      : null;
  const selectedRemotes = single
    ? remotes
        .filter((r) => single.box.sshRemoteRefs.includes(r.remote.name))
        .map((r) => ({
          name: r.remote.name,
          host: r.remote.host,
          tunnelUp: r.tunnelUp,
          tunnelError: r.tunnelError,
        }))
    : [];
  const singleProject = single ? projects.find((p) => p.id === single.box.projectId) : undefined;

  return (
    <div className="bx-app">
      <MenuBar menus={menus} />
      <div className="ab-toolbar" role="toolbar" aria-label="Box actions">
        {tool("New", true, run.newBox, `New Box (${CHORDS.newBox})`)}
        <span className="ab-separator" />
        {tool("Start", states.start, run.start, `Start (${CHORDS.start})`)}
        {tool("Edit", states.edit, run.edit, `Edit Box (${CHORDS.edit})`)}
        {tool("Fork", states.fork, run.fork, `Fork Conversation (${CHORDS.fork})`)}
        {tool("Stop", states.stop, run.stop)}
        {tool("Restart All", states.restartAll, run.restartAll, "Restart All Running")}
        {tool("Attach", states.attach, run.attach, `${attachLabel(single)} (${CHORDS.attach})`)}
        {tool(
          "Open Shell",
          states.openShell,
          run.openShell,
          `Open Shell in Container (${CHORDS.openShell})`,
        )}
        {tool(
          "Review",
          states.startReview,
          run.review,
          "Start a review of this box in the review app",
        )}
        <span className="ab-separator" />
        {tool("Remove", states.remove, run.remove)}
        {tool("Purge", states.purge, run.purge)}
        <span className="ab-spacer" />
        {tool("Refresh Now", true, run.refresh, `Refresh Now (${CHORDS.refresh})`)}
      </div>
      <UpgradeStatus
        runningVersion={bridge()?.appVersion ?? appPackage.version}
        onRelaunch={() => {
          const b = bridge();
          if (b?.relaunch) b.relaunch();
          else window.location.reload();
        }}
        onStatus={upgradeStatus}
        showCliNotice={false}
      />
      <UpdateBars
        updates={updates}
        image={image}
        dismissedVersion={dismissed}
        dockerUnavailable={data.error?.code === "docker_unavailable"}
        serverError={serverError}
        onViewRelease={openLink}
        onDismissRelease={(v) => {
          setDismissed(v);
          store("dismissedVersion", v);
        }}
        onRebuildImage={() => void rebuildImage()}
        onOpenSetup={run.setup}
        onRetry={run.refresh}
      />
      <div className="ab-tabbar bx-pages" role="tablist" aria-label="Pages">
        {PAGES.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={page === p}
            className={`ab-tab${page === p ? " ab-active" : ""}`}
            onClick={() => setPage(p)}
          >
            {PAGE_LABELS[p]}
          </button>
        ))}
      </div>
      <div className="bx-main">
        {page === "usage" ? <UsageView boxes={all} disk={data.disk} /> : null}
        {page === "builds" ? (
          <BuildsView
            builds={builds.builds}
            projects={data.projects}
            selectedId={buildId}
            onSelect={setBuildId}
            error={builds.error}
          />
        ) : null}
        <Splitter
          direction="vertical"
          defaultSizes={[0.48, 0.52]}
          storageKey="outer"
          // A saved or dragged split can't leave an open terminal too short
          // to show Claude's input line. The table keeps a few rows.
          minSizes={[TABLE_MIN_HEIGHT, tabs.tabs.length > 0 ? TERMINAL_MIN_HEIGHT : 0]}
          className="bx-grow"
          // The terminals stay mounted on the other pages.
          style={page !== "boxes" ? { display: "none" } : undefined}
        >
          <Splitter
            direction="horizontal"
            defaultSizes={showDetails ? [0.16, 0.56, 0.28] : [0.2, 0.8]}
            storageKey={showDetails ? "top3" : "top2"}
          >
            <ProjectPanel
              projects={data.projects}
              totalBoxes={all.length}
              selected={projectId}
              onSelect={(id) => setProjectId(id)}
              menuFor={projectMenu}
            />
            <div className="bx-table-area">
              <input
                ref={filterRef}
                className="ab-input"
                type="search"
                aria-label="Filter boxes"
                placeholder={`Filter by status, directory, conversation, or container (${CHORDS.filter})`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setFilter("")}
              />
              <BoxTable
                rows={rows}
                selected={selected}
                onSelectionChange={setSelected}
                onActivate={(b) => {
                  if (b.status === "stopped") void startBox(b);
                  else if (b.status === "running") openTerminal(b);
                }}
                onContextMenu={(b, x, y) => tableMenu.open(x, y, boxMenu(b))}
                sort={sort}
                onSortChange={setSort}
                builds={buildBadges}
              />
            </div>
            {showDetails && (
              <DetailsPanel
                view={single}
                project={singleProject}
                containerStale={
                  single
                    ? data.projects.find((p) => p.project.id === single.box.projectId)?.container
                        ?.stale
                    : undefined
                }
                settings={data.settings}
                diskBytes={single ? data.disk.get(single.container) : undefined}
                remotes={selectedRemotes}
                onRelink={(v) => setDialog({ kind: "changeDir", box: v, title: "Relink" })}
                onReconnect={(name) =>
                  void client
                    .call("sshRemotes.reconnect", { params: { name } })
                    .then(loadRemotes)
                    .catch((err: unknown) => inform("Reconnect", errorMessage(err)))
                }
                onOpenLink={openLink}
              />
            )}
          </Splitter>
          <TerminalTabs
            state={tabs}
            machineLabel={machine.multi ? machine.name : undefined}
            visible={machine.active}
            onSelect={(key) => setTabs((t) => ({ ...t, current: key }))}
            onClose={(key) => setTabs((t) => closeTab(t, key))}
            onCloseOthers={(key) => setTabs((t) => closeOthers(t, key))}
            onCloseAll={() => setTabs(emptyTabs)}
            onEnded={(key, code) => setTabs((t) => markEnded(t, key, code))}
            openLink={openLink}
          />
        </Splitter>
      </div>
      <footer className="ab-statusbar">
        <span>{statusBarText(inProject, rows.length)}</span>
        <span>
          {streamStatus === "open"
            ? ""
            : streamStatus === "connecting"
              ? "connecting... · "
              : "reconnecting · "}
          {data.updatedAt ? updatedText(data.updatedAt) : ""}
        </span>
      </footer>
      {tableMenu.element}
      {renderDialog()}
    </div>
  );

  function renderDialog() {
    if (!dialog) return null;
    const close = () => setDialog(null);
    switch (dialog.kind) {
      case "new":
        return (
          <BoxDialog
            mode="new"
            projects={projects}
            settings={data.settings}
            initialDir={dialog.dir}
            onAccept={acceptNew}
            onCancel={close}
            onManageRemotes={run.sshRemotes}
          />
        );
      case "edit":
        return (
          <BoxDialog
            mode="edit"
            source={dialog.box}
            projects={projects}
            settings={data.settings}
            initialDir={dialog.box.box.targetDir}
            onAccept={acceptEdit(dialog.box)}
            onCancel={close}
            onManageRemotes={run.sshRemotes}
          />
        );
      case "fork":
        return (
          <BoxDialog
            mode="fork"
            source={dialog.box}
            projects={projects}
            settings={data.settings}
            initialDir={dialog.box.box.targetDir}
            onAccept={acceptFork(dialog.box)}
            onCancel={close}
            onManageRemotes={run.sshRemotes}
          />
        );
      case "setup":
        return (
          <SetupWizard
            stacked={dialog.stacked}
            onClose={() => {
              close();
              client
                .call("image.status", {})
                .then(setImage)
                .catch(() => undefined);
            }}
            onDone={() => void data.reload()}
          />
        );
      case "prompts":
        return <PromptsDialog onClose={close} />;
      case "sshRemotes":
        return (
          <SshRemotesDialog
            onClose={() => {
              close();
              loadRemotes();
              void data.reload();
            }}
          />
        );
      case "globalMounts":
        return (
          <GlobalMountsLoader
            onClose={close}
            onSaved={async (stale) => {
              close();
              for (const container of stale) {
                const p = data.projects.find(
                  (x) =>
                    x.container?.name === container ||
                    `aio-agent-proj-${x.project.id}` === container,
                );
                if (p)
                  await offerContainerRestart(
                    p.project.id,
                    data.boxes
                      .filter((b) => b.container === container && b.status === "running")
                      .map((b) => b.box.id),
                    p,
                  );
              }
            }}
          />
        );
      case "job":
        return (
          <JobDialog
            title={dialog.title}
            job={dialog.job}
            stacked={dialog.stacked}
            onClose={close}
            onDone={dialog.onDone}
            renderResult={dialog.renderResult}
          />
        );
      case "projectSettings": {
        const p = dialog.project;
        return (
          <MountsDialog
            title="Project mounts and ports"
            intro={`Mounts and TCP maps for every box of "${p.project.name}", on top of the project root and the global mounts.`}
            mounts={p.project.mounts}
            tcpMaps={p.project.tcpMaps}
            onCancel={close}
            onSave={async (v) => {
              const res = await client.call("projects.update", {
                params: { projectId: p.project.id },
                body: { mounts: v.mounts, ...(v.tcpMaps ? { tcpMaps: v.tcpMaps } : {}) },
              });
              close();
              void data.reload();
              if (res.staleBoxes.length > 0)
                await offerContainerRestart(p.project.id, res.staleBoxes, p);
              return null;
            }}
          />
        );
      }
      case "renameProject": {
        const p = dialog.project;
        return (
          <InputDialog
            title="Rename project"
            label="Name"
            intro="Leave the name empty to use the folder name."
            initial={p.project.name}
            allowEmpty
            onCancel={close}
            onAccept={async (name) => {
              await client.call("projects.update", {
                params: { projectId: p.project.id },
                body: { name },
              });
              close();
              void data.reload();
              return null;
            }}
          />
        );
      }
      case "move": {
        const v = dialog.box;
        return (
          <InputDialog
            title="Move Working Directory"
            label="New directory"
            intro={`Renames ${v.box.targetDir} and its transcript folder, and repoints every box that uses it.`}
            initial={v.box.targetDir}
            browse
            okLabel="Move"
            onCancel={close}
            onAccept={async (newDir) => {
              if (normalizeDir(newDir) === normalizeDir(v.box.targetDir))
                return "Choose a different directory.";
              const res = await client.call("boxes.move", {
                params: { boxId: v.box.id },
                body: { newDir },
              });
              close();
              toast(`Moved ${res.movedBoxes.length} box(es) to ${newDir}.`, { kind: "success" });
              void data.reload();
              return null;
            }}
          />
        );
      }
      case "changeDir": {
        const v = dialog.box;
        return (
          <InputDialog
            title={dialog.title}
            label="Directory"
            intro={`Points only this box at another directory. Nothing on disk moves. Use it when the directory was moved outside AI Orchestrator.`}
            initial={v.box.targetDir}
            browse
            onCancel={close}
            onAccept={async (targetDir) => {
              if (v.status === "running")
                return "This box is running. Stop it before relinking its directory.";
              const res = await client.call("boxes.relink", {
                params: { boxId: v.box.id },
                body: { targetDir },
              });
              data.putBox(res);
              close();
              return null;
            }}
          />
        );
      }
    }
  }
}

function ConvertReport({ job }: { job: Job }) {
  if (job.status !== "finished" || !job.result) {
    return (
      <div className="ab-error-text">
        {job.error?.message ?? "The conversion failed. Nothing was changed."}
      </div>
    );
  }
  const r = job.result as ConvertToWorktreeResult;
  const lines = [
    `Worktree: ${r.worktree}`,
    `Branch: ${r.branch}`,
    `Old folder renamed to: ${r.oldFolder}`,
    `Record backup: ${r.recordBackup}`,
    ...(r.keptRefs.length ? [`Kept refs: ${r.keptRefs.join(", ")}`] : []),
    ...(r.notCarried.length ? ["Not carried over:", ...r.notCarried.map((n) => `  ${n}`)] : []),
    "",
    "The box's next start tells the agent where its files and notes went. You can delete the old folder by hand.",
  ];
  return <div className="ab-message-detail">{lines.join("\n")}</div>;
}

function GlobalMountsLoader({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (stale: string[]) => Promise<void>;
}) {
  const client = useApiClient();
  const [mounts, setMounts] = useState<{ host: string; container: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client
      .call("globalMounts.get", {})
      .then((r) => setMounts(r.mounts))
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [client]);
  if (error) {
    return (
      <MountsDialog
        title="Global Mounts"
        intro={error}
        mounts={[]}
        onCancel={onClose}
        onSave={async () => error}
      />
    );
  }
  if (!mounts) return null;
  return (
    <MountsDialog
      title="Global Mounts"
      intro="Every box gets these mounts, on top of its project's. A mount whose box path the project already uses is skipped."
      mounts={mounts}
      onCancel={onClose}
      onSave={async (v) => {
        const res = await client.call("globalMounts.put", { body: { mounts: v.mounts } });
        await onSaved(res.staleContainers);
        return null;
      }}
    />
  );
}
