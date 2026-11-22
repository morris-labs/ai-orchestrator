// The New Box, Edit Box, and Fork Conversation form: defaults, the name
// auto-fill rule, validation, and the request bodies.
import type {
  Box,
  BoxCreate,
  ConversationSummary,
  Effort,
  GlobalSettings,
  Platform,
  Project,
} from "@aio/contracts";
import { guessHostOs, isAbsoluteHostPath, normalizeWindowsPath } from "@aio/contracts";
import { relativeTime } from "./format";

export type Layout = "worktree" | "workspace" | "root";
export type DialogMode = "new" | "edit" | "fork";

export interface BoxForm {
  platform: Platform;
  targetDir: string;
  /** `""` for a new conversation, else the session uuid to adopt or relink. */
  conversation: string;
  name: string;
  model: string;
  effort: Effort | "";
  layout: Layout;
  skipPermissions: boolean;
  /** The account (`VENDOR/NAME`) of the platform's CLI; `""` uses the vendor's default. */
  account: string;
  sshRemoteRefs: string[];
}

/**
 * The slug a conversation name turns into: runs of characters other than
 * ASCII letters and digits become `_`, and `_` is trimmed from both ends.
 * The server's `slugifyIssueName` does the same; the dialog only uses it to
 * check that a worktree or workspace gets a non-empty name.
 */
export function slugify(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Normalizes a directory for lookups: no trailing slash. A Windows path gets
 * the form the server stores project roots in, `C:/Users/you/project`.
 */
export function normalizeDir(dir: string): string {
  const t = dir.trim();
  if (guessHostOs(t) === "win32") {
    try {
      return normalizeWindowsPath(t);
    } catch {
      return t;
    }
  }
  return t.length > 1 ? t.replace(/\/+$/, "") : t;
}

/** Whether a directory typed in the dialog is absolute, as a POSIX or a Windows path. */
export function isAbsoluteDir(dir: string): boolean {
  const t = dir.trim();
  return isAbsoluteHostPath(t, guessHostOs(t));
}

export function projectForDir(projects: readonly Project[], dir: string): Project | undefined {
  const d = normalizeDir(dir);
  return projects.find((p) => p.root === d);
}

/**
 * The remembered layout for a directory, as 3.3.5 chose it: a worktree when
 * the project has a primary repository and the directory isn't marked "no";
 * else a workspace when the directory is marked "yes", or carries an
 * executable `new-issue.sh` (`newIssueScript`) and has no remembered answer;
 * else the root. The server's `resolveLayout` applies the same rule.
 */
export function defaultLayout(
  dir: string,
  settings: GlobalSettings | null,
  project: Project | undefined,
  newIssueScript = false,
): Layout {
  const d = normalizeDir(dir);
  const worktree = settings?.newBoxDefaults.worktreeDirs[d];
  const workspace = settings?.newBoxDefaults.workspaceDirs[d];
  if (project?.primaryRepo && worktree !== false) return "worktree";
  if (worktree === true) return "worktree";
  if (workspace === true) return "workspace";
  if (workspace === undefined && newIssueScript) return "workspace";
  return "root";
}

/** Whether the worktree layout is possible: unknown directories are left to the server. */
export function worktreeAllowed(project: Project | undefined): boolean {
  return project === undefined || project.primaryRepo !== undefined;
}

/**
 * The name auto-fill rule: picking a conversation fills the name with its
 * title, but never overwrites a name the person typed. `lastAuto` is the
 * value the dialog filled last; a name equal to it (or empty) counts as not
 * typed.
 */
export function autoFillName(
  current: string,
  lastAuto: string | null,
  picked: ConversationSummary | null,
): { name: string; lastAuto: string | null } {
  const typed = current.trim() !== "" && current !== lastAuto;
  if (typed) return { name: current, lastAuto };
  if (picked === null) return { name: lastAuto !== null ? "" : current, lastAuto: null };
  return { name: picked.title, lastAuto: picked.title };
}

/** The conversation combo label: `title [trackedBy] · relative time · N turns`. */
export function conversationLabel(c: ConversationSummary, now: Date = new Date()): string {
  const tracked = c.trackedBy.length > 0 ? ` [${c.trackedBy.join(", ")}]` : "";
  const turns = c.turns === 1 ? "1 turn" : `${c.turns} turns`;
  return `${c.title}${tracked} · ${relativeTime(c.modifiedAt, now)} · ${turns}`;
}

export function conversationTooltip(c: ConversationSummary): string {
  return `${c.sessionUuid}${c.lastPrompt ? `\n\nLast prompt: ${c.lastPrompt}` : ""}`;
}

/** Problems that stop the dialog from accepting. */
export function validateForm(form: BoxForm, mode: DialogMode): string[] {
  const out: string[] = [];
  if (mode !== "edit") {
    if (form.targetDir.trim() === "") out.push("Choose a target directory.");
    else if (!isAbsoluteDir(form.targetDir)) {
      // The server doesn't expand `~`.
      out.push(
        "The target directory must be an absolute path, such as /home/you/project or C:\\Users\\you\\project.",
      );
    }
    // Adopting a conversation creates no worktree or folder, so needs no slug.
    if (
      !adopting(form, mode) &&
      (form.layout === "worktree" || form.layout === "workspace") &&
      slugify(form.name) === ""
    ) {
      out.push(
        `A ${form.layout} is named after the conversation: type a conversation name with at least one letter or digit.`,
      );
    }
  }
  if (form.platform === "claude" && form.model.trim() === "") out.push("Choose a model.");
  return out;
}

/**
 * Whether the form adopts an existing conversation. The server then skips
 * the worktree and the workspace folder, so the layout doesn't apply.
 */
export function adopting(form: BoxForm, mode: DialogMode): boolean {
  return mode === "new" && form.platform === "claude" && form.conversation !== "";
}

/** The `boxes.create` body for the new and fork modes. */
export function createBody(
  form: BoxForm,
  mode: "new" | "fork",
  options: { forkFrom?: string; rememberLayout?: boolean; force?: boolean; start?: boolean } = {},
): BoxCreate {
  const claude = form.platform === "claude";
  let conversation: BoxCreate["conversation"] = { mode: "new" };
  if (mode === "fork" && options.forkFrom)
    conversation = { mode: "fork", fromBoxId: options.forkFrom };
  else if (claude && form.conversation !== "")
    conversation = { mode: "adopt", sessionUuid: form.conversation };
  // An adopted conversation runs in the directory itself, and the layout
  // picked for it isn't a choice to remember for the directory.
  const adopt = conversation.mode === "adopt";
  return {
    targetDir: normalizeDir(form.targetDir),
    platform: form.platform,
    conversationName: form.name.trim(),
    conversation,
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(form.effort ? { effort: form.effort } : {}),
    skipPermissions: form.skipPermissions,
    ...(form.account !== "" ? { accounts: { [form.platform]: form.account } } : {}),
    layout: adopt ? "root" : form.layout,
    rememberLayout: adopt ? false : (options.rememberLayout ?? mode === "new"),
    sshRemoteRefs: form.sshRemoteRefs,
    start: options.start ?? true,
    force: options.force ?? false,
  };
}

/** The form for an existing box, in edit or fork mode. */
export function formFromBox(
  box: Box,
  mode: "edit" | "fork",
  defaults: { model: string; effort: Effort | "" },
): BoxForm {
  return {
    platform: box.platform,
    targetDir: box.targetDir,
    conversation: mode === "edit" ? (box.sessionUuid ?? "") : "",
    name: mode === "fork" ? `${box.conversationName} (fork)` : box.conversationName,
    model: box.model ?? defaults.model,
    effort: box.effort ?? defaults.effort,
    layout: box.worktree ? "worktree" : box.workspace ? "workspace" : "root",
    skipPermissions: box.skipPermissions,
    account: box.accounts?.[box.platform] ?? "",
    sshRemoteRefs: [...box.sshRemoteRefs],
  };
}

/**
 * The `boxes.update` body: only the fields that changed. A model or effort
 * that the record leaves to the settings files counts as changed only when
 * the person picked one by hand (`handPicked`); the value the dialog shows
 * for it is a default, not a choice to pin.
 */
export function updateBody(
  box: Box,
  form: BoxForm,
  handPicked: { model: boolean; effort: boolean },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.name.trim() !== box.conversationName) out.conversationName = form.name.trim();
  const model = form.model.trim();
  if ((box.model !== undefined || handPicked.model) && (model || undefined) !== box.model) {
    out.model = model || null;
  }
  if (
    (box.effort !== undefined || handPicked.effort) &&
    (form.effort || undefined) !== box.effort
  ) {
    out.effort = form.effort || null;
  }
  if (form.skipPermissions !== box.skipPermissions) out.skipPermissions = form.skipPermissions;
  const account = box.accounts?.[box.platform] ?? "";
  if (form.account !== account) {
    out.accounts = { [box.platform]: form.account === "" ? null : form.account };
  }
  const uuid = form.conversation === "" ? null : form.conversation;
  if (uuid !== box.sessionUuid) out.sessionUuid = uuid;
  const refs = [...form.sshRemoteRefs].sort();
  if (JSON.stringify(refs) !== JSON.stringify([...box.sshRemoteRefs].sort()))
    out.sshRemoteRefs = form.sshRemoteRefs;
  return out;
}
