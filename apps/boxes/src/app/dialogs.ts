// The dialogs the main window can open, one at a time.
import type { BoxView, Job, ProjectSummary } from "@agentbox/contracts";
import type { ReactNode } from "react";

export type DialogState =
  | null
  | { kind: "new"; dir: string }
  | { kind: "edit"; box: BoxView }
  | { kind: "fork"; box: BoxView }
  | { kind: "setup"; stacked?: boolean }
  | { kind: "prompts" }
  | { kind: "globalMounts" }
  | { kind: "sshRemotes" }
  | {
      kind: "job";
      title: string;
      job: Job;
      stacked?: boolean;
      onDone?: (job: Job) => void;
      renderResult?: (job: Job) => ReactNode;
    }
  | { kind: "projectSettings"; project: ProjectSummary }
  | { kind: "renameProject"; project: ProjectSummary }
  | { kind: "move"; box: BoxView }
  | { kind: "changeDir"; box: BoxView; title: string };
