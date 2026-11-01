// The expected template text below is the source of truth for the defaults.
// It matches `gui/src/PromptTemplates.cpp` at tag `v3.3.5` byte for byte. Do not
// reformat it.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PORT_HINT_TEMPLATE,
  DEFAULT_PROMPT_TEMPLATES,
  DEFAULT_STARTER_TEMPLATE,
  DEFAULT_WORKSPACE_TEMPLATE,
  DEFAULT_WORKTREE_TEMPLATE,
  SECRETS_PROMPT_HINT,
  expandTemplate,
  parseConfig,
  withSecretsHint,
} from "../src/index.js";

const EXPECTED_WORKSPACE = `Your workspace for this conversation is %3. It already exists.

Before making any changes, read CLAUDE.md if it exists. Then read and maintain %5 (notes on the shared environment) and PLAN.md and STATUS.md in %4 (notes for this conversation only), creating any that do not exist based on the project and the conversation.

Do your work inside %3 rather than in the directory above it.

Use git for versioning. Create local branches and commit your work as you go. Do not push to any remote without explicit instruction.

This container is a sandbox. Install any missing build tools freely without asking. Any files that must survive a container rebuild must be saved inside the project directory.

When you stop work or are asked to checkpoint, update %4/STATUS.md with: the active plan, your current step, what you have done since the last checkpoint, what comes next, and any blockers. Keep STATUS.md under 60 lines.

The conversation was opened as "%2". Wait for details before changing anything.`;

const EXPECTED_WORKTREE = `Your workspace for this conversation is %3, a git worktree of %6 on the branch %7. It already exists.

Before making any changes, read CLAUDE.md if it exists. Then read and maintain %5 (notes on the shared environment) and PLAN.md and STATUS.md in %4 (notes for this conversation only; git ignores that folder), creating any that do not exist based on the project and the conversation.

Do your work inside %3 and commit it to %7. Do not switch branches. The main checkout %6 is the reference copy and a local cache: read it freely, but do not edit files there. Other conversations work in sibling worktrees of the same repository at the same time. Keep every file for this work, code and notes, inside %3.

Use git for versioning and commit your work as you go. Do not push to any remote and do not merge into other branches without explicit instruction.

This container is a sandbox. Install any missing build tools freely without asking. Any files that must survive a container rebuild must be saved inside the project directory.

When you stop work or are asked to checkpoint, update %4/STATUS.md with: the active plan, your current step, what you have done since the last checkpoint, what comes next, and any blockers. Keep STATUS.md under 60 lines.

The conversation was opened as "%2". Wait for details before changing anything.`;

const EXPECTED_PORT_HINT = `The following container ports are mapped to the host: %1. Bind any web server, API, or other network service that the host needs to reach to one of these container-side ports.`;

const EXPECTED_STARTER = `Your working directory is %2. Before doing anything else, read CLAUDE.md if it exists, then read and maintain INFRA.md, PLAN.md, and STATUS.md — creating any that do not exist based on the project and the conversation.

Use git for versioning. Create local branches and commit your work as you go. Do not push to any remote without explicit instruction.

This container is a sandbox. Install any missing build tools freely without asking. Any files that must survive a container rebuild must be saved inside %2.

When you stop work or are asked to checkpoint, update STATUS.md with: the active plan, your current step, what you have done since the last checkpoint, what comes next, and any blockers. Keep STATUS.md under 60 lines.`;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("prompt template defaults", () => {
  it.each([
    [
      "workspace",
      DEFAULT_WORKSPACE_TEMPLATE,
      EXPECTED_WORKSPACE,
      "e27e990239c6078055e489181eb347e5f596a4b81752258849b404abcfe549c8",
    ],
    [
      "worktree",
      DEFAULT_WORKTREE_TEMPLATE,
      EXPECTED_WORKTREE,
      "49c2662bb359790f75cf19decc3024fa2e1de75c232049d8e1e36361c069d6b8",
    ],
    [
      "portHint",
      DEFAULT_PORT_HINT_TEMPLATE,
      EXPECTED_PORT_HINT,
      "0c0d0d641f9f9e4e5a068cd2318e473762f95020e10cf3b34a2f8ba0193d10c1",
    ],
    [
      "starter",
      DEFAULT_STARTER_TEMPLATE,
      EXPECTED_STARTER,
      "cff596918124f9a5d6fe7fb21c888fe06072e4c504bcf0e1e00b3f2a1de057ab",
    ],
  ])("%s matches the 3.3.5 text byte for byte", (_name, actual, expected, hash) => {
    expect(Buffer.from(actual, "utf8").equals(Buffer.from(expected, "utf8"))).toBe(true);
    // Guards against an editor reformatting both copies the same way.
    expect(sha256(expected)).toBe(hash);
  });

  it("keeps the Starter template's em dash", () => {
    expect(DEFAULT_STARTER_TEMPLATE).toContain("STATUS.md \u2014 creating");
  });

  it("is what an empty configuration gets", () => {
    expect(parseConfig({}).promptTemplates).toEqual(DEFAULT_PROMPT_TEMPLATES);
  });

  it("lets an empty string turn a template off", () => {
    expect(parseConfig({ promptTemplates: { starter: "" } }).promptTemplates.starter).toBe("");
  });
});

describe("expandTemplate", () => {
  it("substitutes %N in one pass", () => {
    expect(expandTemplate("%1 then %2", ["a%2", "b"])).toBe("a%2 then b");
  });

  it("leaves a placeholder without an argument as it is", () => {
    expect(expandTemplate("%1 and %3", ["x"])).toBe("x and %3");
  });

  it("expands the worktree template", () => {
    const text = expandTemplate(DEFAULT_WORKTREE_TEMPLATE, [
      "slug",
      "Name",
      "/w",
      "/w/.aio",
      "/p/.aio/INFRA.md",
      "/p",
      "claude/slug",
    ]);
    expect(text).not.toMatch(/%[1-7]/);
    expect(text).toContain('opened as "Name"');
  });
});

describe("secrets hint", () => {
  it("tells the agent how to get a secret and not to reveal it", () => {
    expect(SECRETS_PROMPT_HINT).toContain("aio-secret list");
    expect(SECRETS_PROMPT_HINT).toContain("aio-secret run NAME[,NAME...] -- COMMAND [ARGS...]");
    expect(SECRETS_PROMPT_HINT).toContain(
      "never print a value or write one to a file, a log, or your replies",
    );
    expect(SECRETS_PROMPT_HINT).toContain("`GH_TOKEN` also come from the broker");
    expect(SECRETS_PROMPT_HINT).not.toMatch(/%[1-9]/);
  });

  it("is not part of any default template", () => {
    for (const t of Object.values(DEFAULT_PROMPT_TEMPLATES)) expect(t).not.toContain("aio-secret");
  });

  it("follows the prompt as its own paragraph", () => {
    expect(withSecretsHint("Start here.")).toBe(`Start here.\n\n${SECRETS_PROMPT_HINT}`);
  });

  it("leaves an empty prompt empty", () => {
    expect(withSecretsHint("")).toBe("");
  });
});
