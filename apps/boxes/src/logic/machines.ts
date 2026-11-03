// The machines of a multi-machine install: the hub's machine routes, the
// order of the machine tabs, and the notes the Machines page shows.
import {
  EnrollmentCodeSchema,
  MachineListSchema,
  type EnrollmentCode,
  type Machine,
  type MachineHealth,
} from "@aio/contracts";
import { isApiError, type ApiClient } from "@aio/ui";
import { z } from "zod";
import { formatBytes } from "./format";

export { LOCAL_MACHINE_ID } from "@aio/contracts";

const MACHINES_PATH = "/api/v1/machines";

/** Lists the machines, this server's own first. */
export async function listMachines(client: ApiClient): Promise<Machine[]> {
  const res = await client.request("GET", MACHINES_PATH, MachineListSchema);
  return sortMachines(res.machines);
}

/** Creates a one-time enrollment code for a new machine. */
export function createEnrollmentCode(client: ApiClient): Promise<EnrollmentCode> {
  return client.request("POST", `${MACHINES_PATH}/enrollment-codes`, EnrollmentCodeSchema, {
    body: {},
  });
}

/** Revokes a machine: the hub stops routing to it and refuses its certificate. */
export async function revokeMachine(client: ApiClient, machineId: string): Promise<void> {
  await client.request("DELETE", `${MACHINES_PATH}/${encodeURIComponent(machineId)}`, z.unknown());
}

/**
 * True when an error means the server has no machine routes: an older
 * server, or one that runs as a plain node. The app then shows one machine.
 */
export function machinesUnsupported(err: unknown): boolean {
  return isApiError(err) && [404, 405, 501].includes(err.status);
}

/** This server's machine first, then the others by name. */
export function sortMachines(machines: readonly Machine[]): Machine[] {
  return [...machines].sort(
    (a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name),
  );
}

/** True when a machine gets a tab of its own: an online or offline remote machine. */
export function hasTab(m: Machine): boolean {
  return !m.isLocal && (m.status === "online" || m.status === "offline");
}

/** The status dot of a machine. */
export function machineDot(m: Machine): "running" | "stopped" | "known" | "pending" {
  switch (m.status) {
    case "online":
      return "running";
    case "offline":
      return "stopped";
    case "enrolling":
      return "pending";
    case "revoked":
      return "known";
  }
}

export const machineStatusLabel: Record<Machine["status"], string> = {
  online: "Online",
  offline: "Offline",
  enrolling: "Enrolling",
  revoked: "Revoked",
};

export const machineRoleLabel: Record<Machine["role"], string> = {
  hub: "Hub",
  node: "Node",
  both: "Hub and node",
};

export const machinePlatformLabel: Record<NonNullable<Machine["platform"]>, string> = {
  linux: "Linux",
  darwin: "macOS",
  win32: "Windows",
};

/** How long ago `iso` was, such as `5 minutes ago`, or `never` for `null`. */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "never";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const s = Math.round((now.getTime() - then.getTime()) / 1000);
  if (s < 45) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (s < 3600) return unit(Math.max(1, Math.round(s / 60)), "minute");
  if (s < 86400) return unit(Math.round(s / 3600), "hour");
  return unit(Math.round(s / 86400), "day");
}

/** The last-seen text of a machine: relative, with the exact time. */
export function lastSeenText(m: Machine, now: Date = new Date()): string {
  if (m.lastSeen === null) return "never";
  const d = new Date(m.lastSeen);
  const exact = Number.isNaN(d.getTime()) ? m.lastSeen : d.toLocaleString();
  return `${relativeTime(m.lastSeen, now)} (${exact})`;
}

/**
 * The version-skew notes of a machine against this server's: a different
 * link protocol, or capabilities that this server has and the machine
 * lacks. Empty when the machine matches, or for this server itself.
 */
export function skewNotes(m: Machine, local: Machine | undefined): string[] {
  if (m.isLocal || !local || m.status === "revoked") return [];
  const notes: string[] = [];
  if (m.protocol === null) {
    notes.push("Its link protocol is unknown until it connects.");
  } else if (local.protocol !== null && m.protocol !== local.protocol) {
    const older = m.protocol < local.protocol ? m.name : "this PC";
    notes.push(
      `It uses link protocol ${m.protocol} and this PC uses ${local.protocol}. Update aio-server on ${older}.`,
    );
  }
  const missing = local.capabilities.filter((c) => !m.capabilities.includes(c));
  if (missing.length > 0 && m.protocol !== null) {
    notes.push(
      `It lacks ${missing.join(", ")}. Features that need them don't work on it until its server is updated.`,
    );
  }
  return notes;
}

export const machineImageLabel: Record<MachineHealth["image"], string> = {
  ready: "Ready",
  missing: "Not built",
  mismatch: "Engine mismatch",
  unknown: "Unknown",
};

/** The image cell of a machine: its state, or `-` without health. */
export function imageText(m: Machine): string {
  return m.health ? machineImageLabel[m.health.image] : "-";
}

/** The image cell's tooltip: the engine versions behind the state. */
export function imageTitle(m: Machine): string {
  const h = m.health;
  if (!h) return "The hub hasn't heard this machine's health.";
  const has = h.engineVersion ?? "none";
  return `Engine in the image: ${has}. Expected: ${h.expectedEngineVersion}.`;
}

/** The free disk space of a machine, such as `120 GiB of 1.8 TiB`, or `-`. */
export function diskText(m: Machine): string {
  const h = m.health;
  if (!h || h.diskFreeBytes === null) return "-";
  return h.diskTotalBytes === null
    ? formatBytes(h.diskFreeBytes)
    : `${formatBytes(h.diskFreeBytes)} of ${formatBytes(h.diskTotalBytes)}`;
}

/**
 * The command that enrolls a machine. It asks for the code itself, because a
 * command-line argument shows in the process list and the shell history.
 */
export function joinCommand(code: EnrollmentCode): string {
  return `aio node join ${code.hubUrl}`;
}

/**
 * Reads the hub URL and code from what the user pastes into the setup
 * wizard: the `aio node join HUB_URL` command that the Machines page copies,
 * or the hub URL alone, either one optionally followed by the code. Returns
 * `null` for anything else.
 */
export function parseJoinInput(text: string): { hubUrl: string; code?: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const rest =
    words[0] === "aio" && words[1] === "node" && words[2] === "join" ? words.slice(3) : words;
  const [hubUrl, code, ...extra] = rest;
  if (!hubUrl || extra.length > 0) return null;
  try {
    if (new URL(hubUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return code ? { hubUrl, code } : { hubUrl };
}

/**
 * True when `url` names a loopback host, which reaches only the PC that opens
 * it. That covers the dev-server proxy's `*.localhost` names.
 */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}
