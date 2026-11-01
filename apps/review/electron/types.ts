// Types and constants shared by the Electron main process and its logic.
import type { RunStatus } from "@aio/contracts";

export interface DeepLink {
  project: string | null;
  box: string | null;
  /** The machine that holds the box, from `aio machines list`; `null` for this one. */
  machine: string | null;
}

/** Run statuses the tray counts as active. */
export const ACTIVE_STATUSES_FOR_TRAY: readonly RunStatus[] = [
  "pending",
  "running",
  "paused",
  "waiting_decision",
];
