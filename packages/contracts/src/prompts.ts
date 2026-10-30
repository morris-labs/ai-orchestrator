// Default prompt templates, copied byte for byte from
// `docs/v4/inventory-gui.md` section 4.7 (the 3.3.5 `PromptTemplates.cpp`).
// `expandTemplate()` substitutes `%1` to `%9` in one pass, as the Qt app did.
// The Starter text keeps its original em dash: it is data, not prose.

/** Workspace subfolder template. `%1` slug, `%2` conversation name as typed, `%3` workspace path, `%4` notes directory, `%5` INFRA.md path. */
export const DEFAULT_WORKSPACE_TEMPLATE = `Your workspace for this conversation is %3. It already exists.

Before making any changes, read CLAUDE.md if it exists. Then read and maintain %5 (notes on the shared environment) and PLAN.md and STATUS.md in %4 (notes for this conversation only), creating any that do not exist based on the project and the conversation.

Do your work inside %3 rather than in the directory above it.

Use git for versioning. Create local branches and commit your work as you go. Do not push to any remote without explicit instruction.

This container is a sandbox. Install any missing build tools freely without asking. Any files that must survive a container rebuild must be saved inside the project directory.

When you stop work or are asked to checkpoint, update %4/STATUS.md with: the active plan, your current step, what you have done since the last checkpoint, what comes next, and any blockers. Keep STATUS.md under 60 lines.

The conversation was opened as "%2". Wait for details before changing anything.`;

/** Worktree template. `%1` slug, `%2` conversation name as typed, `%3` worktree path, `%4` notes directory, `%5` INFRA.md path, `%6` primary repository, `%7` branch. */
export const DEFAULT_WORKTREE_TEMPLATE = `Your workspace for this conversation is %3, a git worktree of %6 on the branch %7. It already exists.

Before making any changes, read CLAUDE.md if it exists. Then read and maintain %5 (notes on the shared environment) and PLAN.md and STATUS.md in %4 (notes for this conversation only; git ignores that folder), creating any that do not exist based on the project and the conversation.

Do your work inside %3 and commit it to %7. Do not switch branches. The main checkout %6 is the reference copy and a local cache: read it freely, but do not edit files there. Other conversations work in sibling worktrees of the same repository at the same time. Keep every file for this work, code and notes, inside %3.

Use git for versioning and commit your work as you go. Do not push to any remote and do not merge into other branches without explicit instruction.

This container is a sandbox. Install any missing build tools freely without asking. Any files that must survive a container rebuild must be saved inside the project directory.

When you stop work or are asked to checkpoint, update %4/STATUS.md with: the active plan, your current step, what you have done since the last checkpoint, what comes next, and any blockers. Keep STATUS.md under 60 lines.

The conversation was opened as "%2". Wait for details before changing anything.`;

/** Port hint template. `%1` the list of mapped ports. */
export const DEFAULT_PORT_HINT_TEMPLATE = `The following container ports are mapped to the host: %1. Bind any web server, API, or other network service that the host needs to reach to one of these container-side ports.`;

/** Starter template, used when a box gets no workspace or worktree. `%1` conversation name, `%2` target directory as the container sees it. */
export const DEFAULT_STARTER_TEMPLATE = `Your working directory is %2. Before doing anything else, read CLAUDE.md if it exists, then read and maintain INFRA.md, PLAN.md, and STATUS.md — creating any that do not exist based on the project and the conversation.

Use git for versioning. Create local branches and commit your work as you go. Do not push to any remote without explicit instruction.

This container is a sandbox. Install any missing build tools freely without asking. Any files that must survive a container rebuild must be saved inside %2.

When you stop work or are asked to checkpoint, update STATUS.md with: the active plan, your current step, what you have done since the last checkpoint, what comes next, and any blockers. Keep STATUS.md under 60 lines.`;

/**
 * The paragraph the server adds to an opening prompt when the box's project
 * container has secrets to give: at least one global or project secret
 * reference. It is not a template and has no placeholders. See
 * `docs/secrets.md`.
 */
export const SECRETS_PROMPT_HINT = `Secrets come from the Agent Box secrets broker: run \`agentbox-secret list\` to see their names and \`agentbox-secret run NAME[,NAME...] -- COMMAND [ARGS...]\` to give them to one command, and never print a value or write one to a file, a log, or your replies. Variables such as \`GH_TOKEN\` also come from the broker where the project configures them, so pass them the same way, for example \`agentbox-secret run GH_TOKEN -- gh pr list\`.`;

/**
 * Adds `SECRETS_PROMPT_HINT` to `prompt` as its last paragraph. An empty
 * prompt stays empty, since a box without an opening prompt sends none.
 */
export function withSecretsHint(prompt: string): string {
  return prompt === "" ? "" : `${prompt}\n\n${SECRETS_PROMPT_HINT}`;
}

/** The four default templates, keyed as in `GlobalSettings.promptTemplates`. */
export const DEFAULT_PROMPT_TEMPLATES = {
  workspace: DEFAULT_WORKSPACE_TEMPLATE,
  worktree: DEFAULT_WORKTREE_TEMPLATE,
  portHint: DEFAULT_PORT_HINT_TEMPLATE,
  starter: DEFAULT_STARTER_TEMPLATE,
} as const;

/**
 * Replaces each `%N` (1 to 9) in `template` with `args[N - 1]` in one pass, so
 * a substituted value that contains `%2` is not expanded again. A `%N` with no
 * matching argument stays as it is.
 */
export function expandTemplate(template: string, args: readonly string[]): string {
  return template.replace(/%([1-9])/g, (match, digit: string) => {
    const value = args[Number(digit) - 1];
    return value === undefined ? match : value;
  });
}
