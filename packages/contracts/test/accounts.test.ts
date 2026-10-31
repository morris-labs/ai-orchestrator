import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DIR_ENV,
  AccountCreateSchema,
  AccountIdSchema,
  AccountSeedRequestSchema,
  AccountUpdateSchema,
  GlobalSettingsPatchSchema,
  accountId,
  parseAccountId,
  parseConfig,
} from "../src/index.js";

describe("account ids", () => {
  it("accepts VENDOR/NAME and splits it", () => {
    expect(accountId("claude", "work")).toBe("claude/work");
    expect(parseAccountId("codex/team-2")).toEqual({ vendor: "codex", name: "team-2" });
    for (const bad of ["claude", "gemini/work", "claude/Work", "claude/-x", "claude/a/b", ""]) {
      expect(AccountIdSchema.safeParse(bad).success, bad).toBe(false);
      expect(parseAccountId(bad), bad).toBeNull();
    }
  });

  it("names the variable that moves each CLI's home", () => {
    expect(ACCOUNT_DIR_ENV).toEqual({
      claude: "CLAUDE_CONFIG_DIR",
      codex: "CODEX_HOME",
      copilot: "COPILOT_HOME",
    });
  });
});

describe("account bodies", () => {
  it("defaults overflow off and seeds every vendor as personal", () => {
    expect(AccountCreateSchema.parse({ vendor: "claude", name: "work" })).toEqual({
      vendor: "claude",
      name: "work",
      overflow: false,
    });
    expect(AccountSeedRequestSchema.parse({})).toEqual({
      vendors: ["claude", "codex", "copilot"],
      name: "personal",
      dryRun: false,
    });
  });

  it("rejects unknown fields and clears a ceiling with null", () => {
    expect(AccountCreateSchema.safeParse({ vendor: "claude", name: "w", dir: "/x" }).success).toBe(
      false,
    );
    expect(AccountUpdateSchema.parse({ ceiling: null })).toEqual({ ceiling: null });
  });
});

describe("account settings", () => {
  it("fills accountsMode and accountDefaults for a stored document without them", () => {
    const s = parseConfig({ setupCompleted: true });
    expect(s.accountsMode).toBe("host");
    expect(s.accountDefaults).toEqual({});
  });

  it("patches defaults per vendor and refuses another vendor's account", () => {
    expect(
      GlobalSettingsPatchSchema.parse({
        accountsMode: "accounts",
        accountDefaults: { claude: "claude/work", codex: null },
      }),
    ).toEqual({ accountsMode: "accounts", accountDefaults: { claude: "claude/work", codex: null } });
    expect(
      GlobalSettingsPatchSchema.safeParse({ accountDefaults: { claude: "codex/work" } }).success,
    ).toBe(false);
    expect(GlobalSettingsPatchSchema.safeParse({ accountsMode: "other" }).success).toBe(false);
  });
});
