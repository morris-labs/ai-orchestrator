// Pre-accepting the first-start prompts of a Claude account folder.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { preacceptClaudeAccount, preacceptHostTrust } from "../../src/accounts/preaccept.js";
import { tempDir } from "../tmp.js";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("preacceptClaudeAccount", () => {
  it("creates both files in an empty account folder", () => {
    const dir = tempDir("aio-pre-");
    const r = preacceptClaudeAccount(dir, { trustDirs: ["/work/app"] });
    expect(r.changed).toEqual([
      "installMethod",
      "projects[/work/app].hasTrustDialogAccepted",
      "skipDangerousModePermissionPrompt",
    ]);
    expect(readJson(path.join(dir, ".claude.json"))).toEqual({
      installMethod: "global",
      projects: { "/work/app": { hasTrustDialogAccepted: true } },
    });
    expect(readJson(path.join(dir, "settings.json"))).toEqual({
      skipDangerousModePermissionPrompt: true,
    });
    expect(fs.statSync(path.join(dir, ".claude.json")).mode & 0o777).toBe(0o600);
  });

  it("changes only the named keys and keeps everything else", () => {
    const dir = tempDir("aio-pre-");
    fs.writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({
        installMethod: "native",
        numStartups: 7,
        projects: {
          "/work/app": { allowedTools: ["Bash"], hasTrustDialogAccepted: false },
          "/other": { hasTrustDialogAccepted: true },
        },
      }),
    );
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
    preacceptClaudeAccount(dir, { trustDirs: ["/work/app", "/work"] });
    expect(readJson(path.join(dir, ".claude.json"))).toEqual({
      // A method that is set stays; only a missing one gets the default.
      installMethod: "native",
      numStartups: 7,
      projects: {
        "/work/app": { allowedTools: ["Bash"], hasTrustDialogAccepted: true },
        "/other": { hasTrustDialogAccepted: true },
        "/work": { hasTrustDialogAccepted: true },
      },
    });
    expect(readJson(path.join(dir, "settings.json"))).toEqual({
      model: "opus",
      skipDangerousModePermissionPrompt: true,
    });
  });

  it("sets installMethod when it is missing from an imported file", () => {
    const dir = tempDir("aio-pre-");
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ userID: "u" }));
    preacceptClaudeAccount(dir);
    expect(readJson(path.join(dir, ".claude.json"))).toEqual({
      userID: "u",
      installMethod: "global",
    });
  });

  it("writes nothing when the values are already there", () => {
    const dir = tempDir("aio-pre-");
    preacceptClaudeAccount(dir, { trustDirs: ["/work/app"] });
    const file = path.join(dir, ".claude.json");
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(file, old, old);
    fs.utimesSync(path.join(dir, "settings.json"), old, old);
    const r = preacceptClaudeAccount(dir, { trustDirs: ["/work/app"] });
    expect(r.changed).toEqual([]);
    expect(fs.statSync(file).mtime.getTime()).toBe(old.getTime());
    expect(fs.statSync(path.join(dir, "settings.json")).mtime.getTime()).toBe(old.getTime());
  });

  it("leaves a file that isn't a JSON object alone", () => {
    const dir = tempDir("aio-pre-");
    fs.writeFileSync(path.join(dir, ".claude.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "settings.json"), "[1]");
    const r = preacceptClaudeAccount(dir, { trustDirs: ["/work/app"] });
    expect(r.skipped).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, ".claude.json"), "utf8")).toBe("{ not json");
    expect(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).toBe("[1]");
  });

  it("never writes through a symbolic link, and reports that it lacks the key", () => {
    const dir = tempDir("aio-pre-");
    const hostFile = path.join(tempDir("aio-host-"), "settings.json");
    fs.writeFileSync(hostFile, JSON.stringify({ model: "opus" }));
    fs.symlinkSync(hostFile, path.join(dir, "settings.json"));
    const r = preacceptClaudeAccount(dir);
    expect(r.linkedMissing).toEqual([path.join(dir, "settings.json")]);
    expect(fs.lstatSync(path.join(dir, "settings.json")).isSymbolicLink()).toBe(true);
    expect(readJson(hostFile)).toEqual({ model: "opus" });
  });
});

describe("preacceptHostTrust", () => {
  it("adds only the missing trust entries and keeps other keys", () => {
    const home = tempDir("aio-host-");
    const file = path.join(home, ".claude.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        numStartups: 3,
        projects: { "/a": { hasTrustDialogAccepted: true, x: 1 } },
      }),
    );
    expect(preacceptHostTrust(home, ["/a", "/b"])).toEqual(["projects[/b].hasTrustDialogAccepted"]);
    expect(readJson(file)).toEqual({
      numStartups: 3,
      projects: {
        "/a": { hasTrustDialogAccepted: true, x: 1 },
        "/b": { hasTrustDialogAccepted: true },
      },
    });
    expect(preacceptHostTrust(home, ["/a", "/b"])).toEqual([]);
  });

  it("writes through a link, keeps the link, and adds no installMethod", () => {
    const home = tempDir("aio-host-");
    fs.mkdirSync(path.join(home, ".claude"));
    const real = path.join(home, ".claude", ".claude.json");
    fs.writeFileSync(real, "{}");
    fs.symlinkSync(real, path.join(home, ".claude.json"));
    preacceptHostTrust(home, ["/w"]);
    expect(fs.lstatSync(path.join(home, ".claude.json")).isSymbolicLink()).toBe(true);
    expect(readJson(real)).toEqual({ projects: { "/w": { hasTrustDialogAccepted: true } } });
  });

  it("leaves a missing or invalid file alone", () => {
    const home = tempDir("aio-host-");
    expect(preacceptHostTrust(home, ["/w"])).toEqual([]);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
    fs.writeFileSync(path.join(home, ".claude.json"), "[1]");
    expect(preacceptHostTrust(home, ["/w"])).toEqual([]);
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe("[1]");
  });
});
