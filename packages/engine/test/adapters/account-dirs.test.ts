// The account folder each vendor call uses: the server's account-dirs.json
// in the state directory, read for every call.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACCOUNT_DIR_ENV,
  ENGINE_ACCOUNT_DIRS_FILE,
  type UsageSample,
  type Vendor,
} from "@aio/contracts";
import {
  accountDirSources,
  accountDirsFileIn,
  readAccountDirs,
} from "../../src/adapters/account-dirs.js";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { CopilotAdapter } from "../../src/adapters/copilot.js";
import type { CliVendorAdapter } from "../../src/adapters/types.js";
import { createEngineAdapters } from "../../src/main/adapters.js";
import { tempDir } from "../tmp.js";

const VENDORS: readonly Vendor[] = ["claude", "codex", "copilot"];

/** A CLI that appends the three account variables to `seen` and fails. */
function recordingCli(dir: string): { cli: string; seen: string } {
  const seen = join(dir, "seen.txt");
  const cli = join(dir, "cli");
  writeFileSync(
    cli,
    "#!/bin/sh\n" +
      `printf '%s|%s|%s\\n' "\${CLAUDE_CONFIG_DIR:-unset}" "\${CODEX_HOME:-unset}" ` +
      `"\${COPILOT_HOME:-unset}" >> '${seen}'\nexit 1\n`,
    { mode: 0o755 },
  );
  return { cli, seen };
}

function request(cwd: string) {
  return {
    prompt: "p",
    cwd,
    tools: "read-only" as const,
    timeoutMs: 10_000,
    outputSchema: z.object({}),
  };
}

/** The value a vendor's variable had in each recorded call. */
function seenFor(seen: string, vendor: Vendor): string[] {
  const column = VENDORS.indexOf(vendor);
  return readFileSync(seen, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("|")[column] ?? "");
}

/** What a CLI gets for `name` when the engine sets nothing: the engine's own value. */
function inherited(name: string): string {
  return process.env[name] || "unset";
}

describe("readAccountDirs", () => {
  it("reads the folders and treats a missing or bad file as none", () => {
    const dir = tempDir("account-dirs-");
    const file = join(dir, ENGINE_ACCOUNT_DIRS_FILE);
    expect(readAccountDirs(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ claude: "/data/accounts/claude/personal", extra: 1 }));
    expect(readAccountDirs(file)).toEqual({ claude: "/data/accounts/claude/personal" });
    writeFileSync(file, JSON.stringify({ claude: "relative/folder" }));
    expect(readAccountDirs(file)).toEqual({});
    writeFileSync(file, "{not json");
    expect(readAccountDirs(file)).toEqual({});
    expect(accountDirsFileIn("/run/aio")).toBe(`/run/aio/${ENGINE_ACCOUNT_DIRS_FILE}`);
  });

  it("keeps the good entries of a file with a bad one, and warns", () => {
    const dir = tempDir("account-dirs-");
    const file = join(dir, ENGINE_ACCOUNT_DIRS_FILE);
    writeFileSync(file, JSON.stringify({ claude: "/data/claude", codex: "relative" }));
    const warnings: string[] = [];
    expect(readAccountDirs(file, (m) => warnings.push(m))).toEqual({ claude: "/data/claude" });
    expect(warnings).toEqual([expect.stringMatching(/codex entry .* isn't valid/)]);
    writeFileSync(file, "{not json");
    readAccountDirs(file, (m) => warnings.push(m));
    expect(warnings[1]).toMatch(/Couldn't read the account folders/);
  });
});

describe("account folder for vendor calls", () => {
  it("sets each vendor's variable from the server's file and follows a change", async () => {
    const dir = tempDir("account-env-");
    const { cli, seen } = recordingCli(dir);
    const file = join(dir, ENGINE_ACCOUNT_DIRS_FILE);
    const sources = accountDirSources(file);
    const adapters: Record<Vendor, CliVendorAdapter> = {
      claude: new ClaudeAdapter({ command: cli, accountDir: sources.claude }),
      codex: new CodexAdapter({ command: cli, accountDir: sources.codex }),
      copilot: new CopilotAdapter({ command: cli, accountDir: sources.copilot }),
    };
    const first = {
      claude: "/data/accounts/claude/personal",
      codex: "/data/accounts/codex/personal",
      copilot: "/data/accounts/copilot/personal",
    };
    writeFileSync(file, JSON.stringify(first));
    for (const vendor of VENDORS) await adapters[vendor].review(request(dir)).catch(() => 0);
    // The server rewrites the file when the default changes; no new adapter.
    writeFileSync(file, JSON.stringify({ claude: "/data/accounts/claude/work" }));
    for (const vendor of VENDORS) await adapters[vendor].review(request(dir)).catch(() => 0);

    // Call i of the first round went to VENDORS[i]; the second round follows.
    for (const [i, vendor] of VENDORS.entries()) {
      const values = seenFor(seen, vendor);
      expect(values[i]).toBe(first[vendor]);
    }
    expect(seenFor(seen, "claude")[3]).toBe("/data/accounts/claude/work");
    // No entry keeps the CLI on the engine's own setting (host mode).
    expect(seenFor(seen, "codex")[4]).toBe(inherited(ACCOUNT_DIR_ENV.codex));
    expect(seenFor(seen, "copilot")[5]).toBe(inherited(ACCOUNT_DIR_ENV.copilot));
  });

  it("lets an explicit env entry win over the account folder", async () => {
    const dir = tempDir("account-env-");
    const { cli, seen } = recordingCli(dir);
    await new ClaudeAdapter({
      command: cli,
      accountDir: "/data/accounts/claude/personal",
      env: { CLAUDE_CONFIG_DIR: "/data/explicit" },
    })
      .review(request(dir))
      .catch(() => 0);
    expect(seenFor(seen, "claude")).toEqual(["/data/explicit"]);
  });

  it("wires the engine's adapters to account-dirs.json in the state directory", async () => {
    const stateDir = tempDir("engine-state-");
    const { cli, seen } = recordingCli(stateDir);
    writeFileSync(
      accountDirsFileIn(stateDir),
      JSON.stringify({ claude: "/data/accounts/claude/personal" }),
    );
    const adapters = createEngineAdapters(stateDir, { claude: { command: cli } });
    await adapters.claude.review(request(stateDir)).catch(() => 0);
    expect(seenFor(seen, "claude")).toEqual(["/data/accounts/claude/personal"]);
  });
});

describe("Codex usage label", () => {
  class Probe extends CodexAdapter {
    get label(): string {
      return this.account;
    }
  }

  it("names the account of its folder, or falls back", () => {
    expect(new Probe({ accountDir: "/data/accounts/codex/work" }).label).toBe("codex/work");
    expect(new Probe({ accountDir: "/data/elsewhere" }).label).toBe("codex-default");
  });
});

describe("Claude usage label", () => {
  class LabelProbe extends ClaudeAdapter {
    label(): string {
      return this.account;
    }
  }

  it("reads .claude.json from the account folder the call uses", () => {
    const root = tempDir("account-label-");
    const personal = join(root, "personal");
    const work = join(root, "work");
    for (const [folder, email] of [
      [personal, "personal@example.com"],
      [work, "work@example.com"],
    ] as const) {
      mkdirSync(folder);
      writeFileSync(
        join(folder, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: email } }),
      );
    }
    let current = personal;
    const probe = new LabelProbe({ accountDir: () => current });
    expect(probe.label()).toBe("personal@example.com");
    current = work;
    expect(probe.label()).toBe("work@example.com");
    expect(new LabelProbe({ accountDir: work, account: "label" }).label()).toBe("label");
  });
});

/** A Claude CLI that records its folder, reports one rate-limit window, and succeeds. */
function claudeCli(dir: string): { cli: string; seen: string } {
  const seen = join(dir, "seen.txt");
  const cli = join(dir, "claude-cli");
  const events = [
    { type: "system", subtype: "init", session_id: "session-1", model: "m" },
    {
      type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1793170800 },
    },
    { type: "result", subtype: "success", session_id: "session-1", structured_output: {} },
  ];
  writeFileSync(
    cli,
    "#!/bin/sh\n" +
      `printf '%s\\n' "\${CLAUDE_CONFIG_DIR:-unset}" >> '${seen}'\n` +
      events.map((event) => `echo '${JSON.stringify(event)}'\n`).join(""),
    { mode: 0o755 },
  );
  return { cli, seen };
}

/** A folder holding a `.claude.json` file that names `email`. */
function claudeFolder(root: string, name: string, email: string): string {
  const folder = join(root, name);
  mkdirSync(folder);
  writeFileSync(
    join(folder, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
  return folder;
}

/**
 * A Codex CLI that writes a rollout with one rate-limit reading to its
 * `CODEX_HOME` and succeeds. `during`, if set, runs before the CLI exits.
 */
function codexCli(dir: string, during = ""): string {
  const cli = join(dir, "codex-cli");
  const reading = {
    payload: {
      type: "token_count",
      rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1793170800 } },
    },
  };
  const events = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "item.completed", item: { type: "agent_message", text: "{}" } },
  ];
  writeFileSync(
    cli,
    "#!/bin/sh\n" +
      'day="$CODEX_HOME/sessions/2026/10/28"\n' +
      'mkdir -p "$day"\n' +
      `echo '${JSON.stringify(reading)}' > "$day/rollout-x-thread-1.jsonl"\n` +
      events.map((event) => `echo '${JSON.stringify(event)}'\n`).join("") +
      `${during}\n`,
    { mode: 0o755 },
  );
  return cli;
}

describe("the folder a call runs on", () => {
  it("labels Claude usage from a continuation's folder after the default moves", async () => {
    const root = tempDir("account-pin-");
    const { cli, seen } = claudeCli(root);
    const personal = claudeFolder(root, "personal", "personal@example.com");
    const work = claudeFolder(root, "work", "work@example.com");
    let current = personal;
    const adapter = new ClaudeAdapter({ command: cli, accountDir: () => current });

    const first = await adapter.review(request(root));
    expect(first.sessionId).toBe("session-1");
    current = work;
    const samples: UsageSample[] = [];
    await adapter.continueReview({
      ...request(root),
      sessionId: "session-1",
      onUsage: (sample) => samples.push(sample),
    });

    expect(seenFor(seen, "claude").at(-1)).toBe(personal);
    expect(samples.map((sample) => sample.account)).toEqual(["personal@example.com"]);
  });

  it("labels Codex usage from a continuation's folder after the default moves", async () => {
    const root = tempDir("account-pin-");
    const personal = join(root, "accounts", "codex", "personal");
    const work = join(root, "accounts", "codex", "work");
    let current = personal;
    const adapter = new CodexAdapter({ command: codexCli(root), accountDir: () => current });

    await adapter.review(request(root));
    current = work;
    const more = await adapter.continueReview({ ...request(root), sessionId: "thread-1" });

    expect(more.usage.map((sample) => sample.account)).toEqual(["codex/personal"]);
  });

  it("labels Codex usage from the call's folder when the default moves during it", async () => {
    const root = tempDir("account-pin-");
    const personal = join(root, "accounts", "codex", "personal");
    const work = join(root, "accounts", "codex", "work");
    const file = join(root, ENGINE_ACCOUNT_DIRS_FILE);
    writeFileSync(file, JSON.stringify({ codex: personal }));
    const moveDefault = `echo '${JSON.stringify({ codex: work })}' > '${file}'`;
    const adapter = new CodexAdapter({
      command: codexCli(root, moveDefault),
      accountDir: accountDirSources(file).codex,
    });

    const result = await adapter.review(request(root));

    expect(result.usage.map((sample) => sample.account)).toEqual(["codex/personal"]);
  });

  it("reports a call's folder, and resumes in the folder a caller saved after a restart", async () => {
    const root = tempDir("account-pin-");
    const { cli, seen } = claudeCli(root);
    const personal = claudeFolder(root, "personal", "personal@example.com");
    const work = claudeFolder(root, "work", "work@example.com");
    const first = await new ClaudeAdapter({ command: cli, accountDir: personal }).review(
      request(root),
    );
    expect(first.accountFolder).toBe(personal);

    // A new adapter, as after an engine restart, with the default moved.
    const restarted = new ClaudeAdapter({ command: cli, accountDir: work });
    const resumed = await restarted.continueReview({
      ...request(root),
      sessionId: "session-1",
      sessionFolder: first.accountFolder ?? null,
    });

    expect(seenFor(seen, "claude").at(-1)).toBe(personal);
    expect(resumed.accountFolder).toBe(personal);
  });

  it("resumes a session started on the home folder there after a default appears", async () => {
    const root = tempDir("account-pin-");
    const { cli, seen } = claudeCli(root);
    let current: string | undefined = undefined;
    const adapter = new ClaudeAdapter({ command: cli, accountDir: () => current });

    await adapter.review(request(root));
    current = "/data/accounts/claude/work";
    await adapter.continueReview({ ...request(root), sessionId: "session-1" });
    await adapter.continueReview({ ...request(root), sessionId: "unknown-session" });

    expect(seenFor(seen, "claude").slice(1)).toEqual([
      inherited(ACCOUNT_DIR_ENV.claude),
      "/data/accounts/claude/work",
    ]);
  });
});
