// Maps host paths to the paths a box's Linux container sees, and back.
//
// On Linux and macOS, the server mounts each host folder at its own path, so
// the mapping is the identity. On Windows, a host path such as
// `C:\Users\dev\project` can't be a container path, and its drive colon
// collides with Docker's `HOST:CONTAINER` bind syntax. There, the folder is
// mounted under `/mnt/host/<drive>/`, as `/mnt/host/c/Users/dev/project`.
//
// Every function takes the host operating system as an argument and never
// reads `process.platform`, so the server, the CLI, and the apps decide it
// once and tests can exercise every platform on any host. The module uses no
// Node.js API, so the browser apps can import it too.

/** The operating system the server and its host paths belong to. */
export type HostOs = "linux" | "darwin" | "win32";

/** Every `HostOs` value. */
export const HOST_OSES: readonly HostOs[] = ["linux", "darwin", "win32"];

/**
 * The container folder that holds the Windows drives: drive `C:` is mounted
 * under `/mnt/host/c`. Distinct from WSL's own `/mnt/c`, so a mount never
 * reads as a WSL path.
 */
export const WINDOWS_MOUNT_ROOT = "/mnt/host";

/** Thrown when a host path can't be mapped to a container path. */
export class ContainerPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerPathError";
  }
}

/**
 * The `HostOs` for a Node.js `process.platform` value. Every platform other
 * than Windows and macOS maps like Linux, since its paths are POSIX paths.
 */
export function hostOsFrom(nodePlatform: string): HostOs {
  if (nodePlatform === "win32") return "win32";
  if (nodePlatform === "darwin") return "darwin";
  return "linux";
}

const DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$)/;
const LONG_PREFIX = /^[\\/]{2}[?.][\\/]/;

/** Whether `p` has the shape of a Windows path: a drive letter, a UNC share, or a `\\?\` prefix. */
export function looksLikeWindowsPath(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || /^[\\/]{2}/.test(p);
}

/** Whether `p` is a UNC path, such as `\\server\share\dir` or `\\?\UNC\server\share`. */
export function isUncPath(p: string): boolean {
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(p)) return true;
  return /^[\\/]{2}[^\\/?.]/.test(p);
}

/**
 * The host OS a path most likely belongs to, judged by its shape: `win32`
 * for a Windows-shaped path, else `linux`. For code that has a path but no
 * other word on the host, such as an app's mount editor. A POSIX absolute
 * path always starts with `/`, so it never reads as Windows.
 */
export function guessHostOs(p: string): HostOs {
  return looksLikeWindowsPath(p) ? "win32" : "linux";
}

/** Splits on `/`, drops empty and `.` parts, and applies `..`, never above the root. */
function cleanSegments(rest: string): string[] {
  const out: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

/**
 * Normalizes an absolute POSIX path as Node.js `path.posix.resolve()` does
 * for one: collapses repeated slashes, applies `.` and `..`, and drops a
 * trailing slash. Throws `ContainerPathError` for a relative path.
 */
export function normalizePosixPath(p: string): string {
  if (!p.startsWith("/")) throw new ContainerPathError(`${p} is not an absolute path.`);
  return `/${cleanSegments(p).join("/")}`;
}

/**
 * Normalizes an absolute Windows path to the form the server stores: an
 * uppercase drive letter, forward slashes, `.` and `..` applied, and no
 * trailing slash except on a drive root, such as `C:/Users/dev/project` or
 * `C:/`. Strips a `\\?\` prefix. Throws `ContainerPathError` for a UNC
 * path, a device path, a path with no drive letter, and a drive-relative
 * path such as `C:project`.
 */
export function normalizeWindowsPath(p: string): string {
  let s = p;
  if (isUncPath(s)) {
    throw new ContainerPathError(
      `${p} is a UNC network path, which AI Orchestrator can't mount yet. Map the share to a drive letter, or copy the folder to a local drive.`,
    );
  }
  if (LONG_PREFIX.test(s)) {
    if (s[2] === ".") throw new ContainerPathError(`${p} is a device path, not a folder.`);
    s = s.slice(4);
  }
  s = s.replace(/\\/g, "/");
  if (!/^[A-Za-z]:/.test(s)) {
    throw new ContainerPathError(
      `${p} is not an absolute Windows path. Start it with a drive letter, such as C:\\.`,
    );
  }
  if (s.length > 2 && s[2] !== "/") {
    throw new ContainerPathError(
      `${p} is relative to the current folder of drive ${s.slice(0, 2)}. Give the full path, such as ${s.slice(0, 2)}\\${s.slice(2)}.`,
    );
  }
  const drive = (s[0] as string).toUpperCase();
  return `${drive}:/${cleanSegments(s.slice(2)).join("/")}`;
}

/**
 * Normalizes an absolute host path for `os`: `normalizeWindowsPath()` on
 * Windows, `normalizePosixPath()` elsewhere.
 */
export function normalizeHostPath(p: string, os: HostOs): string {
  return os === "win32" ? normalizeWindowsPath(p) : normalizePosixPath(p);
}

/**
 * The path at which a box's container sees the absolute host path `hostPath`.
 *
 * - Linux and macOS: the normalized host path itself.
 * - Windows: `/mnt/host/<drive>/<rest>`, with the drive letter in lowercase
 *   and forward slashes, so `C:\Users\dev\project` becomes
 *   `/mnt/host/c/Users/dev/project`. The rest keeps its case.
 *
 * Throws `ContainerPathError` for a relative path and, on Windows, for the
 * paths `normalizeWindowsPath()` refuses.
 */
export function hostToContainer(hostPath: string, os: HostOs): string {
  if (os !== "win32") return normalizePosixPath(hostPath);
  const n = normalizeWindowsPath(hostPath);
  const rest = n.slice(3);
  return `${WINDOWS_MOUNT_ROOT}/${n[0]!.toLowerCase()}${rest === "" ? "" : `/${rest}`}`;
}

/**
 * The host path for a container path that `hostToContainer()` produces, or
 * `null` when the container path has no host counterpart under the mapping,
 * such as `/home/dev/.claude` on Windows. On Windows the result has the
 * stored form, such as `C:/Users/dev/project`.
 */
export function containerToHost(containerPath: string, os: HostOs): string | null {
  if (!containerPath.startsWith("/")) return null;
  const c = normalizePosixPath(containerPath);
  if (os !== "win32") return c;
  const m = /^\/mnt\/host\/([a-z])(?:\/(.*))?$/.exec(c);
  if (!m) return null;
  return `${m[1]!.toUpperCase()}:/${m[2] ?? ""}`;
}

/** The parts of a `HOST[:CONTAINER[:OPTIONS]]` mount spec or Docker bind string. */
export interface MountSpecParts {
  host: string;
  /** Empty when the spec has no container part. */
  container: string;
  /** Docker's bind options, such as `ro`; absent when the spec has none. */
  options?: string;
}

/**
 * Splits a `HOST[:CONTAINER[:OPTIONS]]` mount spec or Docker bind string.
 *
 * The separator is the first colon, except that on Windows the colon of a
 * leading drive letter (`C:`, or `\\?\C:`) belongs to the host path. A
 * container path never holds a colon, so a colon after the container path
 * starts the options.
 */
export function splitMountSpec(spec: string, os: HostOs): MountSpecParts {
  let from = 0;
  if (os === "win32") {
    if (/^[A-Za-z]:/.test(spec)) from = 2;
    else if (/^[\\/]{2}\?[\\/][A-Za-z]:/.test(spec)) from = 6;
  }
  const i = spec.indexOf(":", from);
  if (i < 0) return { host: spec, container: "" };
  const host = spec.slice(0, i);
  const rest = spec.slice(i + 1);
  const j = rest.indexOf(":");
  if (j < 0) return { host, container: rest };
  return { host, container: rest.slice(0, j), options: rest.slice(j + 1) };
}

/** Joins mount spec parts into `HOST:CONTAINER[:OPTIONS]`, the form Docker binds take. */
export function joinMountSpec(parts: MountSpecParts): string {
  const base = `${parts.host}:${parts.container}`;
  return parts.options ? `${base}:${parts.options}` : base;
}

/**
 * The container path a mount gets when only its host path is given:
 * `hostToContainer()` for the OS the path's shape suggests. Returns the
 * host path unchanged when it can't be mapped, so the caller's own
 * validation reports the problem.
 */
export function defaultContainerPath(hostPath: string): string {
  const os = guessHostOs(hostPath);
  if (os === "linux") return hostPath;
  try {
    return hostToContainer(hostPath, os);
  } catch {
    return hostPath;
  }
}

/** Whether `p` is absolute for `os`, before any normalization. */
export function isAbsoluteHostPath(p: string, os: HostOs): boolean {
  return os === "win32"
    ? DRIVE_PATH.test(p) || LONG_PREFIX.test(p) || isUncPath(p)
    : p.startsWith("/");
}
