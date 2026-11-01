// Conversion between the policy file, its YAML text, and the editor form.
import { PolicyFileSchema, type PolicyFile } from "@aio/contracts";
import { isMap, parse, parseDocument, stringify } from "yaml";

export type ParseResult = { ok: true; policy: PolicyFile } | { ok: false; errors: string[] };

export function policyToYaml(policy: PolicyFile): string {
  return stringify(policy, { lineWidth: 100 });
}

/**
 * The policy file text with `policy` applied: only the top-level keys whose
 * value changed are rewritten, so comments, key order, and formatting
 * elsewhere survive. Text that isn't a valid policy is replaced whole.
 */
export function mergePolicyYaml(text: string, policy: PolicyFile): string {
  if (text.trim() === "") return policyToYaml(policy);
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return policyToYaml(policy);
  const before = validatePolicy(doc.toJS() ?? {});
  if (!before.ok) return policyToYaml(policy);
  if (!isMap(doc.contents)) return policyToYaml(policy);
  const oldValues = before.policy as Record<string, unknown>;
  const newValues = policy as Record<string, unknown>;
  const keys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
  for (const key of keys) {
    const next = newValues[key];
    if (JSON.stringify(oldValues[key]) === JSON.stringify(next)) continue;
    if (next === undefined) doc.delete(key);
    else doc.set(key, doc.createNode(next));
  }
  return doc.toString({ lineWidth: 100 });
}

/** Parses YAML text and validates it with the contract schema. */
export function parsePolicyYaml(text: string): ParseResult {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return { ok: false, errors: [`YAML: ${(err as Error).message.split("\n")[0]}`] };
  }
  return validatePolicy(doc ?? {});
}

export function validatePolicy(doc: unknown): ParseResult {
  const parsed = PolicyFileSchema.safeParse(doc);
  if (parsed.success) return { ok: true, policy: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (i) => `${i.path.length ? i.path.join(".") : "policy"}: ${i.message}`,
    ),
  };
}

/** Splits a textarea into trimmed, non-empty lines. */
export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Splits a comma-separated list; empty gives `undefined`. */
export function commaList(text: string): string[] | undefined {
  const items = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** Reports whether two optional lists hold the same items in the same order. */
export function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
