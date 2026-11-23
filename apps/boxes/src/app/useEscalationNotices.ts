// Desktop notifications for escalations that wait in the Builds area. The
// app notifies the owner once about each escalation whose pointer didn't
// reach the Project manager's session in time, and a click on the
// notification opens the build. Each machine's view notifies about its own
// builds, so a click names the machine. The app remembers which escalations
// it notified about in local storage, per machine, so a restart doesn't
// notify again.
import type { BuildSummary, PmItem } from "@aio/contracts";
import { useEffect, useRef } from "react";
import { bridge } from "../bridge";
import {
  escalationsToNotify,
  noticeKey,
  parseNotified,
  serializeNotified,
} from "../logic/escalations";
import { useMachine } from "./machine";
import type { OpenEscalations } from "./useOpenEscalations";

interface BuildNotice {
  title: string;
  body: string;
  buildId: string;
  machineId: string;
}

/**
 * Shows a notice through the Electron bridge, or, in a plain browser that
 * allows notifications, through the Notification API.
 */
function show(notice: BuildNotice, onClick: () => void): void {
  const b = bridge();
  if (b) {
    b.notifyBuild?.(notice);
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const n = new Notification(notice.title, { body: notice.body });
  n.onclick = () => {
    window.focus();
    onClick();
  };
}

/** The local storage key of a machine's notified escalations. */
function storageKey(machineId: string): string {
  return `ab.notifiedEscalations.${machineId}`;
}

function loadNotified(machineId: string): Set<string> {
  try {
    return parseNotified(localStorage.getItem(storageKey(machineId)));
  } catch {
    return new Set();
  }
}

function saveNotified(machineId: string, notified: ReadonlySet<string>): void {
  try {
    localStorage.setItem(storageKey(machineId), serializeNotified(notified));
  } catch {
    // Storage can be unavailable; the record then lasts for this session only.
  }
}

/** The notice's text for an escalation of `build`. */
export function escalationNotice(build: BuildSummary | undefined, item: PmItem) {
  return { title: `Escalation waits in ${build?.slug ?? "a build"}`, body: item.summary };
}

export function useEscalationNotices(
  open: OpenEscalations,
  builds: readonly BuildSummary[],
  onOpen: (buildId: string) => void,
): void {
  const machine = useMachine();
  const notified = useRef<{ machineId: string; keys: Set<string> } | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const activateRef = useRef(machine.activate);
  activateRef.current = machine.activate;
  const machineId = machine.id;

  useEffect(() => {
    if (notified.current?.machineId !== machineId) {
      notified.current = { machineId, keys: loadNotified(machineId) };
    }
    const { keys } = notified.current;
    const notices = escalationsToNotify(open, keys, Date.now());
    for (const { buildId, item } of notices) keys.add(noticeKey(buildId, item));
    if (notices.length > 0) saveNotified(machineId, keys);
    for (const { buildId, item } of notices) {
      const build = builds.find((b) => b.id === buildId);
      show({ ...escalationNotice(build, item), buildId, machineId }, () => {
        activateRef.current();
        onOpenRef.current(buildId);
      });
    }
  }, [open, builds, machineId]);

  useEffect(
    () =>
      bridge()?.onSelectBuild?.((buildId, from) => {
        if (from !== machineId) return;
        activateRef.current();
        onOpenRef.current(buildId);
      }),
    [machineId],
  );
}
