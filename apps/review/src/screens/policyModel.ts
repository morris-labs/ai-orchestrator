// Conversion between the policy file, its YAML text, and the editor form.
import { PolicyFileSchema, type PolicyFile } from "@agentbox/contracts";
import { parse, stringify } from "yaml";

export type ParseResult = { ok: true; policy: PolicyFile } | { ok: false; errors: string[] };

export function policyToYaml(policy: PolicyFile): string {
  return stringify(policy, { lineWidth: 100 });
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
