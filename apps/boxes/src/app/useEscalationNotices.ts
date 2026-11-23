// Desktop notifications for escalations that wait in the Builds area. The
// app notifies the owner once about each escalation whose pointer didn't
// reach the Project manager's session in time, and a click on the
// notification opens the build. Each machine's view notifies about its own
// builds, so a click names the machine.
import type { BuildSummary, PmItem } from "@aio/contracts";
import { useEffect, useRef } from "react";
import { bridge } from "../bridge";
import { escalationsToNotify, noticeKey } from "../logic/escalations";
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
  const notified = useRef(new Set<string>());
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const activateRef = useRef(machine.activate);
  activateRef.current = machine.activate;
  const machineId = machine.id;

  useEffect(() => {
    for (const { buildId, item } of escalationsToNotify(open, notified.current, Date.now())) {
      notified.current.add(noticeKey(buildId, item));
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
