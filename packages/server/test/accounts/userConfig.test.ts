// Legacy settings links remain protected until explicit account migration.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { preacceptClaudeAccount } from "../../src/accounts/preaccept.js";
import { ensureRetention, retentionWarnings } from "../../src/accounts/retention.js";
import { tempDir } from "../tmp.js";

function setup(): { host: string; account: string } {
  const root = fs.realpathSync(tempDir("aio-uc-"));
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

describe("a settings.json that links to the host's", () => {
  it("passes the retention check without writing the host's file", () => {
    const { host, account } = setup();
    fs.symlinkSync(path.join(host, "settings.json"), path.join(account, "settings.json"));
    const before = fs.readFileSync(path.join(host, "settings.json"), "utf8");
    expect(ensureRetention(account, 3650)).toBe(false);
    expect(fs.readFileSync(path.join(host, "settings.json"), "utf8")).toBe(before);
    expect(fs.lstatSync(path.join(account, "settings.json")).isSymbolicLink()).toBe(true);
    expect(retentionWarnings(account, 3650)).toEqual([]);
  });

  it("blocks instead of raising a low value in the host's file", () => {
    const { host, account } = setup();
    fs.writeFileSync(path.join(host, "settings.json"), JSON.stringify({ cleanupPeriodDays: 30 }));
    fs.symlinkSync(path.join(host, "settings.json"), path.join(account, "settings.json"));
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
    fs.symlinkSync(path.join(host, "settings.json"), path.join(account, "settings.json"));
    const r = preacceptClaudeAccount(account);
    expect(r.linkedMissing).toEqual([path.join(account, "settings.json")]);
    expect(JSON.parse(fs.readFileSync(path.join(host, "settings.json"), "utf8"))).toEqual({
      cleanupPeriodDays: 3650,
    });
    expect(fs.lstatSync(path.join(account, "settings.json")).isSymbolicLink()).toBe(true);
  });

  it("passes the pre-acceptance when the host's file has the key", () => {
    const { host, account } = setup();
    fs.symlinkSync(path.join(host, "settings.json"), path.join(account, "settings.json"));
    expect(preacceptClaudeAccount(account).linkedMissing).toEqual([]);
  });
});
