// Turns the policy into prompt text for reviewers and verifiers.
import type { PolicyFile, PolicyRule } from "@agentbox/contracts";
import { matchesAny } from "./glob.js";

/** The rules that apply to at least one of `files`; every rule when `files` is absent. */
export function rulesFor(policy: PolicyFile, files?: readonly string[]): PolicyRule[] {
  return policy.rules.filter(
    (rule) => !rule.appliesTo || files === undefined || files.some((f) => matchesAny(f, rule.appliesTo ?? [])),
  );
}

/** True when `file` matches one of the policy's risk paths. */
export function isRiskPath(policy: PolicyFile, file: string): boolean {
  return matchesAny(file, policy.riskPaths);
}

/**
 * The repository section of a prompt: the rules for `files` and the
 * environment limits. Empty when the policy has neither.
 */
export function policyPromptSection(policy: PolicyFile, files?: readonly string[]): string {
  const rules = rulesFor(policy, files);
  const parts: string[] = [];
  if (rules.length > 0) {
    parts.push(
      "Repository rules. Treat a breach of any of these as a finding:",
      ...rules.map((r) => `- [${r.id}] ${r.text}${r.appliesTo ? ` (applies to ${r.appliesTo.join(", ")})` : ""}`),
    );
  }
  if (policy.environmentLimits.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("Environment limits. Take these into account:", ...policy.environmentLimits.map((l) => `- ${l}`));
  }
  return parts.join("\n");
}
