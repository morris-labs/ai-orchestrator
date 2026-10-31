// Checks on the workspace's own configuration files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The value of a top-level `key: value` line in `pnpm-workspace.yaml`. */
function workspaceSetting(key: string): string | undefined {
  const text = fs.readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8");
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z][\w-]*):\s*(\S.*)$/.exec(line);
    if (m && m[1] === key) return m[2]!.trim();
  }
  return undefined;
}

describe("pnpm store", () => {
  // The host and a box that mounts the checkout must agree on the store.
  // Without a pinned store, pnpm picks one at the root of the checkout's
  // file system, which differs between the host and a container.
  it("pins a relative, git-ignored store inside the workspace", () => {
    expect(workspaceSetting("storeDir")).toBe(".pnpm-store");
    const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n");
    expect(gitignore).toContain(".pnpm-store/");
  });
});
