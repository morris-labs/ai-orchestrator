import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DirListingSchema } from "@agentbox/contracts";
import { listDirs, resolveDirQuery } from "../../src/api/fs-dirs.js";

function tree(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-dirs-")));
  fs.mkdirSync(path.join(home, "b-dir"));
  fs.mkdirSync(path.join(home, "a-dir", "inner"), { recursive: true });
  fs.writeFileSync(path.join(home, "file.txt"), "x");
  fs.symlinkSync(path.join(home, "a-dir"), path.join(home, "c-link"));
  fs.symlinkSync(path.join(home, "file.txt"), path.join(home, "d-file-link"));
  return home;
}

describe("fs.dirs", () => {
  it("lists subdirectories and directory links only, sorted", async () => {
    const home = tree();
    const listing = DirListingSchema.parse(await listDirs(home, undefined));
    expect(listing.path).toBe(home);
    expect(listing.parent).toBe(path.dirname(home));
    expect(listing.entries.map((e) => e.name)).toEqual(["a-dir", "b-dir", "c-link"]);
    expect(listing.entries[0]?.path).toBe(path.join(home, "a-dir"));
  });

  it("resolves ~, normalizes .., and refuses relative paths", () => {
    expect(resolveDirQuery("/home/user", "~")).toBe("/home/user");
    expect(resolveDirQuery("/home/user", "~/work")).toBe("/home/user/work");
    expect(resolveDirQuery("/home/user", "/srv/../etc")).toBe("/etc");
    expect(() => resolveDirQuery("/home/user", "work")).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
  });

  it("refuses files and missing paths, and stops at the root", async () => {
    const home = tree();
    await expect(listDirs(home, path.join(home, "file.txt"))).rejects.toMatchObject({
      code: "validation",
    });
    await expect(listDirs(home, path.join(home, "missing"))).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await listDirs(home, "/")).parent).toBeNull();
  });
});
