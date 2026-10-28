// Pulls JSON values out of model text that may wrap them in prose or code
// fences.

/**
 * Returns every JSON object or array in `text` that parses, in order of
 * appearance. A value nested inside another candidate is not listed again.
 */
export function extractJsonCandidates(text: string): unknown[] {
  const whole = tryParse(text.trim());
  if (whole.ok && isContainer(whole.value)) return [whole.value];

  const found: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const end = matchingClose(text, i);
      if (end > i) {
        const parsed = tryParse(text.slice(i, end + 1));
        if (parsed.ok) {
          found.push(parsed.value);
          i = end + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  return found;
}

/**
 * Returns the last JSON value in `text` that `accept` approves, or the last
 * value at all when `accept` is absent. Throws when there is none. Models
 * tend to restate a draft before the final answer, so the last one wins.
 */
export function extractJson(text: string, accept?: (value: unknown) => boolean): unknown {
  const candidates = extractJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const value = candidates[i];
    if (!accept || accept(value)) return value;
  }
  throw new Error(
    candidates.length === 0
      ? "The output holds no JSON object or array."
      : "The output holds JSON, but none of it has the expected shape.",
  );
}

/** Recursively removes object properties whose value is `null`. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== null) out[key] = dropNulls(inner);
    }
    return out;
  }
  return value;
}

function isContainer(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Index of the bracket that closes the one at `start`, honoring strings; -1 if none. */
function matchingClose(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}
