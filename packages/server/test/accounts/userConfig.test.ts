// Shared user configuration: links from a Claude account to the host's ~/.claude.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { preacceptClaudeAccount } from "../../src/accounts/preaccept.js";
import { ensureRetention, retentionWarnings } from "../../src/accounts/retention.js";
import { linkUserConfig, sharedNames, userConfigWarnings } from "../../src/accounts/userConfig.js";
import { linkTargetsOutside } from "../../src/docker/launch.js";
import { tempDir } from "../tmp.js";

function setup(): { host: string; account: string } {
  const root = fs.realpathSync(tempDir("agentbox-uc-"));
  const host = path.join(root, "host");
  const account = path.join(root, "account");
  fs.mkdirSync(path.join(host, "skills", "s1"), { recursive: true });
  fs.writeFileSync(path.join(host, "skills", "s1", "SKILL.md"), "skill\n");
  fs.writeFileSync(path.join(host, "CLAUDE.md"), "global\n");
  fs.writeFileSync(
    path.join(host, "settings.json"),
    JSON.stringify({ cleanupPeriodDays: 3650, skipDangerousModePermissionPrompt: true }),
  );
  fs.writeFileSync(path.join(host, "statusline-command.sh"), "#!/bin/sh\n");
  // Sign-in and per-account state that must never be linked.
  for (const n of [".credentials.json", ".claude.json", "history.jsonl", "policy-limits.json"]) {
    fs.writeFileSync(path.join(host, n), "secret\n");
  }
  for (const n of ["sessions", "projects", "todos", "statsig", "shell-snapshots"]) {
    fs.mkdirSync(path.join(host, n));
  }
  fs.mkdirSync(account);
  return { host, account };
}

describe("linkUserConfig", () => {
  it("links the user-config entries the host has, and nothing else", () => {
    const { host, account } = setup();
    const r = linkUserConfig(account, host);
    expect(r.entries).toEqual({
      "CLAUDE.md": "linked",
      "settings.json": "linked",
      skills: "linked",
      "statusline-command.sh": "linked",
    });
    expect(fs.readlinkSync(path.join(account, "skills"))).toBe(path.join(host, "skills"));
    expect(fs.readdirSync(account).sort()).toEqual([
      "CLAUDE.md",
      "settings.json",
      "skills",
      "statusline-command.sh",
    ]);
    expect(sharedNames(host)).not.toContain(".credentials.json");
    expect(sharedNames(host)).not.toContain("projects");
  });

  it("is repeatable and leaves a local override alone", () => {
    const { host, account } = setup();
    fs.writeFileSync(path.join(account, "CLAUDE.md"), "mine\n");
    const first = linkUserConfig(account, host);
    expect(first.entries["CLAUDE.md"]).toBe("local");
    const second = linkUserConfig(account, host);
    expect(second.entries["CLAUDE.md"]).toBe("local");
    expect(second.entries.skills).toBe("unchanged");
    expect(fs.lstatSync(path.join(account, "CLAUDE.md")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(account, "CLAUDE.md"), "utf8")).toBe("mine\n");
    expect(fs.readFileSync(path.join(host, "CLAUDE.md"), "utf8")).toBe("global\n");
  });

  it("replaces a copy identical to the host's, and a link that dangles", () => {
    const { host, account } = setup();
    fs.cpSync(path.join(host, "skills"), path.join(account, "skills"), { recursive: true });
    fs.symlinkSync(path.join(account, "gone"), path.join(account, "CLAUDE.md"));
    const r = linkUserConfig(account, host);
    expect(r.entries.skills).toBe("replaced-identical");
    expect(r.entries["CLAUDE.md"]).toBe("linked");
    expect(fs.lstatSync(path.join(account, "skills")).isSymbolicLink()).toBe(true);
  });

  it("keeps a copy that differs from the host's", () => {
    const { host, account } = setup();
    fs.cpSync(path.join(host, "skills"), path.join(account, "skills"), { recursive: true });
    fs.writeFileSync(path.join(account, "skills", "s1", "SKILL.md"), "edited\n");
    expect(linkUserConfig(account, host).entries.skills).toBe("local");
    expect(fs.readFileSync(path.join(account, "skills", "s1", "SKILL.md"), "utf8")).toBe(
      "edited\n",
    );
  });

  it("does nothing when the account folder is the host folder", () => {
    const { host } = setup();
    expect(linkUserConfig(host, host).entries).toEqual({});
  });

  it("makes the container mount the targets", () => {
    const { host, account } = setup();
    linkUserConfig(account, host);
    const targets = linkTargetsOutside(account);
    expect(targets).toContain(path.join(host, "skills"));
    expect(targets).toContain(path.join(host, "settings.json"));
    expect(targets.some((t) => t.endsWith(".credentials.json"))).toBe(false);
  });
});

describe("userConfigWarnings", () => {
  it("reports an unlinked entry and a local override, and nothing for links", () => {
    const { host, account } = setup();
    expect(userConfigWarnings(account, host).join("\n")).toMatch(/CLAUDE.md isn't linked/);
    fs.writeFileSync(path.join(account, "CLAUDE.md"), "mine\n");
    const w = userConfigWarnings(account, host).join("\n");
    expect(w).toMatch(/CLAUDE.md is a local override/);
    fs.rmSync(path.join(account, "CLAUDE.md"));
    linkUserConfig(account, host);
    expect(userConfigWarnings(account, host)).toEqual([]);
  });
});

describe("a settings.json that links to the host's", () => {
  it("passes the retention check without writing the host's file", () => {
    const { host, account } = setup();
    linkUserConfig(account, host);
    const before = fs.readFileSync(path.join(host, "settings.json"), "utf8");
    expect(ensureRetention(account, 3650)).toBe(false);
    expect(fs.readFileSync(path.join(host, "settings.json"), "utf8")).toBe(before);
    expect(fs.lstatSync(path.join(account, "settings.json")).isSymbolicLink()).toBe(true);
    expect(retentionWarnings(account, 3650)).toEqual([]);
  });

  it("blocks instead of raising a low value in the host's file", () => {
    const { host, account } = setup();
    fs.writeFileSync(path.join(host, "settings.json"), JSON.stringify({ cleanupPeriodDays: 30 }));
    linkUserConfig(account, host);
    expect(() => ensureRetention(account, 3650)).toThrow(/doesn't rewrite your host file/);
    expect(JSON.parse(fs.readFileSync(path.join(host, "settings.json"), "utf8"))).toEqual({
      cleanupPeriodDays: 30,
    });
    expect(retentionWarnings(account, 3650)[0]).toMatch(/won't start/);
    fs.writeFileSync(path.join(host, "settings.json"), "{}");
    expect(() => ensureRetention(account, 3650)).toThrow(/sets cleanupPeriodDays to nothing/);
  });

  it("is not written by the pre-acceptance, which reports a missing key", () => {
    const { host, account } = setup();
    fs.writeFileSync(path.join(host, "settings.json"), JSON.stringify({ cleanupPeriodDays: 3650 }));
    linkUserConfig(account, host);
    const r = preacceptClaudeAccount(account);
    expect(r.linkedMissing).toEqual([path.join(account, "settings.json")]);
    expect(JSON.parse(fs.readFileSync(path.join(host, "settings.json"), "utf8"))).toEqual({
      cleanupPeriodDays: 3650,
    });
    expect(fs.lstatSync(path.join(account, "settings.json")).isSymbolicLink()).toBe(true);
  });

  it("passes the pre-acceptance when the host's file has the key", () => {
    const { host, account } = setup();
    linkUserConfig(account, host);
    expect(preacceptClaudeAccount(account).linkedMissing).toEqual([]);
  });
});
