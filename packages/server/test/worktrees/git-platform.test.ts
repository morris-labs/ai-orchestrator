import { describe, expect, it } from "vitest";
import { SAFE_GIT_CONFIG, emptyHooksPath, safeGitConfig } from "../../src/worktrees/git.js";

describe("the safe git configuration on each host", () => {
  it("points hooks at a path that can't hold any", () => {
    expect(emptyHooksPath("linux")).toBe("/dev/null");
    expect(emptyHooksPath("darwin")).toBe("/dev/null");
    expect(emptyHooksPath("win32")).toBe("NUL");
  });

  it("changes only the hooks path on Windows", () => {
    expect(safeGitConfig("linux")).toEqual(SAFE_GIT_CONFIG);
    const win = safeGitConfig("win32");
    expect(win[0]).toEqual(["core.hooksPath", "NUL"]);
    expect(win.slice(1)).toEqual(SAFE_GIT_CONFIG.slice(1));
  });
});
