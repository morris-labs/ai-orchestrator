// Pre-accepting the first-start prompts of a Claude account folder.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { preacceptClaudeAccount } from "../../src/accounts/preaccept.js";
import { tempDir } from "../tmp.js";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("preacceptClaudeAccount", () => {
  it("creates both files in an empty account folder", () => {
    const dir = tempDir("agentbox-pre-");
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
    const dir = tempDir("agentbox-pre-");
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
    const dir = tempDir("agentbox-pre-");
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ userID: "u" }));
    preacceptClaudeAccount(dir);
    expect(readJson(path.join(dir, ".claude.json"))).toEqual({
      userID: "u",
      installMethod: "global",
    });
  });

  it("writes nothing when the values are already there", () => {
    const dir = tempDir("agentbox-pre-");
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
    const dir = tempDir("agentbox-pre-");
    fs.writeFileSync(path.join(dir, ".claude.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "settings.json"), "[1]");
    const r = preacceptClaudeAccount(dir, { trustDirs: ["/work/app"] });
    expect(r.skipped).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, ".claude.json"), "utf8")).toBe("{ not json");
    expect(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).toBe("[1]");
  });

  it("replaces a symbolic link instead of writing through it", () => {
    const dir = tempDir("agentbox-pre-");
    const hostFile = path.join(tempDir("agentbox-host-"), "settings.json");
    fs.writeFileSync(hostFile, JSON.stringify({ model: "opus" }));
    fs.symlinkSync(hostFile, path.join(dir, "settings.json"));
    preacceptClaudeAccount(dir);
    expect(fs.lstatSync(path.join(dir, "settings.json")).isSymbolicLink()).toBe(false);
    expect(readJson(path.join(dir, "settings.json"))).toMatchObject({
      model: "opus",
      skipDangerousModePermissionPrompt: true,
    });
    expect(readJson(hostFile)).toEqual({ model: "opus" });
  });
});
