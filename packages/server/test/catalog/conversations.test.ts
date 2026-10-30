import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationSummarySchema } from "@agentbox/contracts";
import {
  condense,
  claudePathHash,
  encodeProjectDir,
  listConversations,
  openingPromptTitle,
  projectDirFor,
  titleForUuid,
  transcriptExists,
} from "../../src/catalog/index.js";
import type { HostEnv } from "../../src/records/env.js";
import { tempDir } from "../tmp.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

let home: string;
let env: HostEnv;
const workDir = "/work/my.proj";

const user = (text: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text }, ...extra });

function write(uuid: string, lines: string[], mtime?: Date): string {
  const dir = projectDirFor(env, workDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

beforeEach(() => {
  home = tempDir("catalog-");
  env = { home, user: "tester", now: () => new Date() };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("path encoding", () => {
  it("replaces every character outside [0-9A-Za-z] with a dash", () => {
    expect(encodeProjectDir("/home/u/my.proj-x y")).toBe("-home-u-my-proj-x-y");
  });
  it("replaces each UTF-16 unit of a non-ASCII character", () => {
    expect(encodeProjectDir("/a/é")).toBe("-a--");
    expect(encodeProjectDir("/a/😀")).toBe("-a---");
  });
  it("truncates and hashes a name longer than 200 characters as Claude Code does", () => {
    // Java's String.hashCode("hello"), which Claude Code's hash matches.
    expect(claudePathHash("hello")).toBe(99162322);
    const long = `/home/tester/${"SYNTHETIC_long_directory_name/".repeat(8)}`;
    const encoded = encodeProjectDir(long);
    expect(encoded).toHaveLength(207);
    expect(encoded).toBe(
      `${"-home-tester-" + "SYNTHETIC-long-directory-name-".repeat(6)}SYNTHET-mc3r3c`,
    );
    const exactly200 = `/${"a".repeat(199)}`;
    expect(encodeProjectDir(exactly200)).toBe(`-${"a".repeat(199)}`);
  });
  it("cleans the path first and gives empty for an empty directory", () => {
    expect(encodeProjectDir("/a/b/")).toBe("-a-b");
    expect(projectDirFor(env, "")).toBe("");
    expect(projectDirFor(env, "/x")).toBe(path.join(home, ".claude/projects/-x"));
  });
});

describe("condense and openingPromptTitle", () => {
  it("collapses whitespace and cuts with an ellipsis", () => {
    expect(condense("  a\n\n b\tc  ", 70)).toBe("a b c");
    expect(condense("abcdef ghij", 8)).toBe("abcdef…");
  });
  it("keeps only the issue name of an old issue prompt", () => {
    expect(openingPromptTitle("Issue: Emails. Your workspace folder x/ exists")).toBe("Emails");
    expect(openingPromptTitle("Hello")).toBe("Hello");
  });
});

describe("listConversations", () => {
  it("applies title precedence, turn counting, and the sort order", async () => {
    write(
      U1,
      [
        user("first prompt"),
        JSON.stringify({ type: "ai-title", aiTitle: "AI one" }),
        JSON.stringify({ type: "custom-title", customTitle: "Old custom" }),
        JSON.stringify({ type: "custom-title", customTitle: "New custom" }),
        user("side", { isSidechain: true }),
        user("meta", { isMeta: true }),
        user([{ type: "tool_result", content: "x" }]),
        user([{ type: "text", text: "second" }]),
        JSON.stringify({ type: "last-prompt", lastPrompt: "the\nlast  prompt" }),
        "not json at all",
      ],
      new Date(2026, 0, 1),
    );
    write(
      U2,
      [
        user("<command-name>/model</command-name>"),
        user("Issue: Emails not sending. Your workspace folder Emails/ already exists"),
        JSON.stringify({ type: "ai-title", aiTitle: "first ai" }),
        JSON.stringify({ type: "ai-title", aiTitle: "second ai" }),
      ],
      new Date(2026, 5, 1),
    );
    write(U3, [JSON.stringify({ type: "assistant", message: {} })]); // no user turn
    fs.writeFileSync(path.join(projectDirFor(env, workDir), "notes.txt"), "x");

    const list = await listConversations(env, workDir, new Map([[U1, ["claude-agent-a"]]]));
    expect(list.map((c) => c.sessionUuid)).toEqual([U2, U1]);
    for (const c of list) ConversationSummarySchema.parse(c);
    const [c2, c1] = list as [(typeof list)[0], (typeof list)[0]];
    expect(c1).toMatchObject({
      title: "New custom",
      titleSource: "custom-title",
      turns: 2,
      lastPrompt: "the last prompt",
      trackedBy: ["claude-agent-a"],
    });
    expect(c2).toMatchObject({
      title: "second ai",
      titleSource: "ai-title",
      turns: 2,
      trackedBy: [],
    });
  });

  it("falls back to the prompt, then to the uuid prefix", async () => {
    write(U1, [user("<x>"), user("Issue: Emails not sending. Your workspace folder E/ exists")]);
    write(U2, [user("<only a command>")]);
    write(U3, [user("x".repeat(100))]);
    const byId = new Map(
      (await listConversations(env, workDir, new Map())).map((c) => [c.sessionUuid, c]),
    );
    expect(byId.get(U1)).toMatchObject({ title: "Emails not sending", titleSource: "prompt" });
    expect(byId.get(U2)).toMatchObject({ title: "22222222", titleSource: "none" });
    expect(byId.get(U3)?.title).toBe(`${"x".repeat(69)}…`);
  });

  it("returns nothing for a directory without transcripts", async () => {
    expect(await listConversations(env, "/nowhere", new Map())).toEqual([]);
  });
});

describe("titleForUuid and transcriptExists", () => {
  it("reads one transcript", async () => {
    write(U1, [user("hello there"), JSON.stringify({ type: "ai-title", aiTitle: "AI" })]);
    write(U2, [user("plain prompt")]);
    write(U3, [JSON.stringify({ type: "custom-title", customTitle: "No turns" })]);
    expect(await titleForUuid(env, workDir, U1)).toBe("AI");
    expect(await titleForUuid(env, workDir, U2)).toBe("plain prompt");
    expect(await titleForUuid(env, workDir, U3)).toBe("");
    expect(await titleForUuid(env, workDir, "missing")).toBe("");
    expect(await transcriptExists(env, workDir, U1)).toBe(true);
    expect(await transcriptExists(env, workDir, "missing")).toBe(false);
  });
});
