// The New Box, Edit Box, and Fork Conversation form: defaults, the name
// auto-fill rule, validation, and the request bodies.
import type {
  Box,
  BoxCreate,
  BoxView,
  ConversationSummary,
  Effort,
  GlobalSettings,
  Platform,
  Project,
} from "@agentbox/contracts";
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
  effort: Effort;
  layout: Layout;
  skipPermissions: boolean;
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

/** Normalizes a directory for lookups: no trailing slash. */
export function normalizeDir(dir: string): string {
  const t = dir.trim();
  return t.length > 1 ? t.replace(/\/+$/, "") : t;
}

export function projectForDir(projects: readonly Project[], dir: string): Project | undefined {
  const d = normalizeDir(dir);
  return projects.find((p) => p.root === d);
}

/**
 * The remembered layout for a directory, as 3.3.5 chose it: a worktree when
 * the project has a primary repository and the directory isn't marked "no";
 * else a workspace when the directory is marked "yes"; else the root.
 */
export function defaultLayout(
  dir: string,
  settings: GlobalSettings | null,
  project: Project | undefined,
): Layout {
  const d = normalizeDir(dir);
  const worktree = settings?.newBoxDefaults.worktreeDirs[d];
  const workspace = settings?.newBoxDefaults.workspaceDirs[d];
  if (project?.primaryRepo && worktree !== false) return "worktree";
  if (worktree === true) return "worktree";
  if (workspace === true) return "workspace";
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
    else if (!form.targetDir.trim().startsWith("/") && !form.targetDir.trim().startsWith("~")) {
      out.push("The target directory must be an absolute path.");
    }
    if ((form.layout === "worktree" || form.layout === "workspace") && slugify(form.name) === "") {
      out.push(
        `A ${form.layout} is named after the conversation: type a conversation name with at least one letter or digit.`,
      );
    }
  }
  if (form.platform === "claude" && form.model.trim() === "") out.push("Choose a model.");
  return out;
}

/** The `boxes.create` body for the new and fork modes. */
export function createBody(
  form: BoxForm,
  mode: "new" | "fork",
  options: { forkFrom?: string; rememberLayout?: boolean; force?: boolean } = {},
): BoxCreate {
  const claude = form.platform === "claude";
  let conversation: BoxCreate["conversation"] = { mode: "new" };
  if (mode === "fork" && options.forkFrom)
    conversation = { mode: "fork", fromBoxId: options.forkFrom };
  else if (claude && form.conversation !== "")
    conversation = { mode: "adopt", sessionUuid: form.conversation };
  return {
    targetDir: normalizeDir(form.targetDir),
    platform: form.platform,
    conversationName: form.name.trim(),
    conversation,
    ...(claude ? { model: form.model.trim(), effort: form.effort } : {}),
    skipPermissions: form.skipPermissions,
    layout: form.layout,
    rememberLayout: options.rememberLayout ?? mode === "new",
    sshRemoteRefs: form.sshRemoteRefs,
    start: true,
    force: options.force ?? false,
  };
}

/** The form for an existing box, in edit or fork mode. */
export function formFromBox(
  box: Box,
  mode: "edit" | "fork",
  defaults: { model: string; effort: Effort },
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
    sshRemoteRefs: [...box.sshRemoteRefs],
  };
}

/** The `boxes.update` body: only the fields that changed. */
export function updateBody(box: Box, form: BoxForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.name.trim() !== box.conversationName) out.conversationName = form.name.trim();
  if (box.platform === "claude") {
    if (form.model.trim() !== (box.model ?? "")) out.model = form.model.trim();
    if (form.effort !== box.effort) out.effort = form.effort;
  }
  if (form.skipPermissions !== box.skipPermissions) out.skipPermissions = form.skipPermissions;
  const uuid = form.conversation === "" ? null : form.conversation;
  if (uuid !== box.sessionUuid) out.sessionUuid = uuid;
  const refs = [...form.sshRemoteRefs].sort();
  if (JSON.stringify(refs) !== JSON.stringify([...box.sshRemoteRefs].sort()))
    out.sshRemoteRefs = form.sshRemoteRefs;
  return out;
}

/** The box that holds a session, for the adoption check; running holders first. */
export function sessionHolders(
  boxes: readonly BoxView[],
  uuid: string,
  except?: string,
): BoxView[] {
  return boxes
    .filter((b) => b.box.sessionUuid === uuid && b.box.id !== except)
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
}
