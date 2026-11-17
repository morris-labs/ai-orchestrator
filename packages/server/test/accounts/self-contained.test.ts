import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeHarness } from "../boxes/harness.js";

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe("self-contained accounts", () => {
  it("relink copies file and directory links without touching host bytes or real account files", () => {
    const h = makeHarness({ accounts: false });
    const view = h.core.accounts.create({ vendor: "claude", name: "old" });
    const host = path.join(h.home, ".claude");
    write(path.join(host, "CLAUDE.md"), "host instructions\n");
    write(path.join(host, "skills", "example.md"), "host skill\n");
    fs.rmSync(path.join(view.dir, "CLAUDE.md"));
    fs.symlinkSync(path.join(host, "CLAUDE.md"), path.join(view.dir, "CLAUDE.md"));
    fs.symlinkSync(path.join(host, "skills"), path.join(view.dir, "skills"));
    write(path.join(view.dir, "local.md"), "own rules\n");
    const before = fs.readFileSync(path.join(host, "CLAUDE.md"), "utf8");
    h.core.accounts.relink();
    expect(fs.lstatSync(path.join(view.dir, "CLAUDE.md")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(view.dir, "skills")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(view.dir, "skills", "example.md"), "utf8")).toBe(
      "host skill\n",
    );
    expect(fs.readFileSync(path.join(host, "CLAUDE.md"), "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(host, "skills", "example.md"), "utf8")).toBe("host skill\n");
    expect(fs.lstatSync(path.join(view.dir, "projects")).isSymbolicLink()).toBe(true);
    expect(h.core.accounts.relink().accounts[0]?.config.entries["CLAUDE.md"]).not.toBe("copied");
    expect(fs.readFileSync(path.join(view.dir, "local.md"), "utf8")).toBe("own rules\n");
    h.core.close();
  });

  it("keeps identical and edited real entries, reports dangling host links, and protects its own settings", () => {
    const h = makeHarness({ accounts: false });
    const view = h.core.accounts.create({ vendor: "claude", name: "local" });
    const host = path.join(h.home, ".claude");
    write(path.join(host, "CLAUDE.md"), "same\n");
    write(path.join(view.dir, "CLAUDE.md"), "same\n");
    write(path.join(view.dir, "skills", "own.md"), "local skill\n");
    fs.symlinkSync(path.join(host, "gone"), path.join(view.dir, "missing.md"));
    const report = h.core.accounts.relink();
    expect(report.accounts[0]?.config.errors["missing.md"]).toBeTruthy();
    expect(fs.lstatSync(path.join(view.dir, "CLAUDE.md")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(view.dir, "skills", "own.md"), "utf8")).toBe("local skill\n");
    expect(h.core.accounts.list()[0]?.warnings ?? []).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(view.dir, "settings.json"), "utf8"))).toMatchObject(
      { cleanupPeriodDays: 3650, skipDangerousModePermissionPrompt: true },
    );
    h.core.close();
  });

  it("imports settings and skills as independent copies rather than host links", async () => {
    const h = makeHarness({ accounts: false });
    const host = path.join(h.home, ".claude");
    write(path.join(host, "settings.json"), '{"model":"copied-model"}');
    write(path.join(host, "skills", "example.md"), "copied skill");
    const source = h.dir("signed-in");
    fs.symlinkSync(path.join(host, "settings.json"), path.join(source, "settings.json"));
    fs.symlinkSync(path.join(host, "skills"), path.join(source, "skills"));
    const result = await h.core.accounts.importFolder({
      vendor: "claude",
      name: "imported",
      from: source,
    });
    expect(fs.lstatSync(path.join(result.dir, "settings.json")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(result.dir, "skills")).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(host, "settings.json"), "utf8"))).toEqual({
      model: "copied-model",
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(result.dir, "settings.json"), "utf8")),
    ).toMatchObject({
      model: "copied-model",
      cleanupPeriodDays: 3650,
      skipDangerousModePermissionPrompt: true,
    });
    h.core.close();
  });

  it("creates its own settings and only links projects outside accounts", () => {
    const h = makeHarness({ accounts: false });
    write(
      path.join(h.home, ".claude", "settings.json"),
      '{"model":"host-only","cleanupPeriodDays":9999}',
    );
    write(path.join(h.home, ".claude", "CLAUDE.md"), "host instructions");
    write(path.join(h.home, ".claude", "skills", "example.md"), "host skill");
    const view = h.core.accounts.create({ vendor: "claude", name: "clean" });
    const linked = fs
      .readdirSync(view.dir)
      .filter((name) => fs.lstatSync(path.join(view.dir, name)).isSymbolicLink());
    expect(linked).toEqual(["projects"]);
    expect(JSON.parse(fs.readFileSync(path.join(view.dir, "settings.json"), "utf8"))).toMatchObject(
      { cleanupPeriodDays: 3650, skipDangerousModePermissionPrompt: true },
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(view.dir, "settings.json"), "utf8")).model,
    ).toBeUndefined();
    expect(view.warnings ?? []).toEqual([]);
    h.core.close();
  });
});
