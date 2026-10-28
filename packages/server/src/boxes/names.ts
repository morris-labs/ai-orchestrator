// Box naming (inventory section 4.8). Both sanitizers are ASCII-only on
// purpose: they byte-match the bash `tr` and `sed` pipelines that named the
// first boxes, so existing boxes keep resolving.
import { CONTAINER_PREFIX } from "@agentbox/contracts";
import { tmuxSessionName } from "../records/box.js";

/** `tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_.-' '-'`, per UTF-16 code unit. */
export function sanitizeBoxBase(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

// The bash pipeline was `tr -cs '[:alnum:]' '_'`, then `sed` trimmed leading
// and trailing underscores. ASCII letters and digits only.
/** Joins runs of ASCII letters and digits with `_`, as the issue-name slugifier did. */
export function slugifyIssueName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * `claude-agent-<sanitized base>`, with `-2`, `-3`, and so on appended until
 * it collides with nothing in `taken`: container names, record ids, and live
 * tmux sessions. tmux rewrites `.` and `:`, so the rewritten form must be
 * free too.
 */
export function uniqueBoxName(base: string, taken: ReadonlySet<string>): string {
  const sanitized = sanitizeBoxBase(base);
  let candidate = `${CONTAINER_PREFIX}${sanitized}`;
  for (let n = 2; taken.has(candidate) || taken.has(tmuxSessionName(candidate)); n += 1) {
    candidate = `${CONTAINER_PREFIX}${sanitized}-${n}`;
  }
  return candidate;
}
