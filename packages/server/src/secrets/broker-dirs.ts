// Removes the broker directories that no container uses. A server before
// `brokerDirName` named each directory after its container, and a removed
// container leaves its directory behind; nothing else removes either.
import fs from "node:fs";
import path from "node:path";
import { HOME_PATHS } from "@agentbox/contracts";
import type { DockerClient } from "../docker/types.js";
import { brokerDirName, dataPath, type HostEnv } from "../records/env.js";

/**
 * Removes each directory directly under `<data dir>/broker/` that no
 * container, running or stopped, mounts or would mount, and returns the
 * removed names. Run it while the server opens no broker socket, such as at
 * start: a container's directory exists before its container does.
 *
 * It never follows a symbolic link: a link in `broker/`, or `broker/`
 * itself as a link, stays as it is, and so does anything that isn't a
 * directory. Throws, and removes nothing, when Docker can't list the
 * containers, since it then can't tell which directories are in use.
 */
export async function removeUnusedBrokerDirs(
  env: Pick<HostEnv, "home" | "dataDir">,
  docker: Pick<DockerClient, "listContainers" | "inspectContainer">,
): Promise<string[]> {
  const root = dataPath(env, HOME_PATHS.brokerDir);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const used = new Set<string>();
  for (const c of await docker.listContainers({ all: true, nameRegex: "." })) {
    used.add(brokerDirName(c.name));
    const inspect = await docker.inspectContainer(c.id);
    // A server before the hashed names named the directory after the
    // container. The bind check below keeps it for a container that still
    // mounts it; without inspect data, keep it, since nothing tells.
    if (!inspect) used.add(c.name);
    for (const bind of inspect?.binds ?? []) {
      const host = bind.split(":")[0] ?? "";
      if (path.dirname(path.resolve(host)) === root) used.add(path.basename(host));
    }
  }

  const removed: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || used.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    // Checked again just before removal; `rmSync` removes a link inside
    // the directory without following it.
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed.sort();
}
