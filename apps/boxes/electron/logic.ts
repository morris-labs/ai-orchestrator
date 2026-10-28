// Pure logic of the Electron main process, kept apart from `electron` so
// that tests can run it under Node.
import type { BoxView, Notification, NotificationKind } from "@agentbox/contracts";

// ---------------------------------------------------------------------------
// External terminals

/**
 * The Linux terminal candidates, in order (inventory section 5): `$TERMINAL`,
 * then x-terminal-emulator, gnome-terminal, xterm, kitty, and alacritty.
 */
export function terminalCandidates(env: Record<string, string | undefined>): string[] {
  const list = ["x-terminal-emulator", "gnome-terminal", "xterm", "kitty", "alacritty"];
  const own = env.TERMINAL?.trim();
  return own ? [own, ...list.filter((t) => t !== own)] : list;
}

/** The command that runs `argv` in terminal `terminal`, with each terminal's own syntax. */
export function terminalCommand(
  terminal: string,
  argv: readonly string[],
  title: string,
): { file: string; args: string[] } {
  const name = terminal.split("/").pop() ?? terminal;
  switch (name) {
    case "gnome-terminal":
      return { file: terminal, args: ["--title", title, "--", ...argv] };
    case "kitty":
      return { file: terminal, args: ["--title", title, ...argv] };
    case "alacritty":
      return { file: terminal, args: ["--title", title, "-e", ...argv] };
    case "xterm":
      return { file: terminal, args: ["-T", title, "-e", ...argv] };
    // xfce4-terminal's -e takes one command string; -x takes the rest as argv.
    case "xfce4-terminal":
      return { file: terminal, args: ["--title", title, "-x", ...argv] };
    case "foot":
      return { file: terminal, args: ["--title", title, ...argv] };
    case "wezterm":
      return { file: terminal, args: ["start", "--", ...argv] };
    default:
      return { file: terminal, args: ["-e", ...argv] };
  }
}

/** Finds the first candidate on `PATH`, or `null`. `exists` checks one path. */
export function findTerminal(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): string | null {
  const dirs = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter(Boolean);
  for (const c of terminalCandidates(env)) {
    if (c.includes("/")) {
      if (exists(c)) return c;
      continue;
    }
    for (const d of dirs) {
      if (exists(`${d}/${c}`)) return `${d}/${c}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tray

export interface TrayCounts {
  running: number;
  stopped: number;
  transitioning: number;
}

export function trayCounts(boxes: readonly Pick<BoxView, "status">[]): TrayCounts {
  return {
    running: boxes.filter((b) => b.status === "running").length,
    stopped: boxes.filter((b) => b.status === "stopped").length,
    transitioning: boxes.filter((b) => b.status === "starting" || b.status === "stopping").length,
  };
}

/** The tray tooltip and status line: `Agent Box: 2 running · 3 not running`. */
export function trayText(counts: TrayCounts | null): string {
  if (counts === null) return "Agent Box: server not reachable";
  const parts = [`${counts.running} running`, `${counts.stopped} not running`];
  if (counts.transitioning > 0) parts.push(`${counts.transitioning} changing`);
  return `Agent Box: ${parts.join(" · ")}`;
}

/**
 * The tray icon as a BGRA bitmap: the accent-colored rounded square of the
 * app, with a status dot in the corner (green when a box runs, gray when
 * none does, red when the server is unreachable).
 */
export function trayIconBitmap(size: number, state: "running" | "idle" | "offline"): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const accent = [0xd9, 0x77, 0x57];
  const dot =
    state === "running"
      ? [0x5f, 0xb3, 0x7a]
      : state === "idle"
        ? [0x8a, 0x8f, 0x98]
        : [0xd9, 0x6c, 0x6c];
  const r = size * 0.2;
  const dotR = size * 0.22;
  const dotC = size - dotR - 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const cx = Math.max(r, Math.min(size - 1 - r, x));
      const cy = Math.max(r, Math.min(size - 1 - r, y));
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      const inDot = (x - dotC) ** 2 + (y - dotC) ** 2 <= dotR * dotR;
      const ring = (x - dotC) ** 2 + (y - dotC) ** 2 <= (dotR + size * 0.06) ** 2;
      let rgb: number[] | null = inside ? accent : null;
      // A prompt mark: a chevron in the window background color.
      const u = x / size;
      const v = y / size;
      if (
        inside &&
        u > 0.22 &&
        u < 0.5 &&
        Math.abs(v - 0.45) < 0.2 &&
        Math.abs(Math.abs(v - 0.45) - (0.5 - u) * 0.75) < 0.06
      ) {
        rgb = [0x1b, 0x1c, 0x1e];
      }
      if (ring && !inDot) rgb = [0x1b, 0x1c, 0x1e];
      if (inDot) rgb = dot;
      if (rgb) {
        buf[i] = rgb[2] as number;
        buf[i + 1] = rgb[1] as number;
        buf[i + 2] = rgb[0] as number;
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Notifications and the review app

/** Notification kinds about boxes; the review app shows the run kinds. */
export const BOX_NOTIFICATION_KINDS: readonly NotificationKind[] = ["box_ended"];

/** True for notifications this app shows: box kinds, or any notification about a box but no run. */
export function isBoxNotification(n: Pick<Notification, "kind" | "runId" | "boxId">): boolean {
  return BOX_NOTIFICATION_KINDS.includes(n.kind) || (n.runId === null && n.boxId !== null);
}

/**
 * The argv that launches the review app with the launcher prefilled. The
 * review app also takes an `agentbox-review://launch?project=&box=` URL or a
 * bare `?project=&box=` query; the flags are the form this app uses.
 * `binary` comes from `AGENTBOX_REVIEW_BIN` when it is set.
 */
export function reviewCommand(
  projectId: string,
  boxId: string,
  binary: string | undefined = undefined,
): { file: string; args: string[] } {
  return {
    file: binary || "agentbox-review",
    args: [`--project=${projectId}`, `--box=${boxId}`],
  };
}

/** The server origin from the environment: `AGENTBOX_SERVER_URL`, else the default port. */
export function serverUrl(env: Record<string, string | undefined>): string {
  return (env.AGENTBOX_SERVER_URL ?? "http://127.0.0.1:21400").replace(/\/$/, "");
}
