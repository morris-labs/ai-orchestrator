// The logic of the Secrets section in the box dialog: which 1Password fields
// are ticked, what each is named, and what to save. The list edits the
// project's `secretRefs`, because the secrets broker is per container and a
// project's boxes share one container.
import { EnvVarNameSchema, type SecretCandidate, type SecretRef } from "@aio/contracts";

/** The ticked references of the project, as `ref` to the variable name. */
export type SecretSelection = Record<string, string>;

export function selectionFromRefs(refs: readonly SecretRef[]): SecretSelection {
  return Object.fromEntries(refs.map((r) => [r.ref, r.name]));
}

/** A name for a newly ticked reference that no other tick uses: `NAME`, `NAME_2`, `NAME_3`... */
export function freeName(proposed: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(proposed)) return proposed;
  for (let n = 2; ; n += 1) {
    if (!used.has(`${proposed}_${n}`)) return `${proposed}_${n}`;
  }
}

export function tick(sel: SecretSelection, c: SecretCandidate): SecretSelection {
  if (c.ref in sel) return sel;
  return { ...sel, [c.ref]: freeName(c.suggestedName, Object.values(sel)) };
}

export function untick(sel: SecretSelection, ref: string): SecretSelection {
  const { [ref]: _gone, ...rest } = sel;
  return rest;
}

export function rename(sel: SecretSelection, ref: string, name: string): SecretSelection {
  return ref in sel ? { ...sel, [ref]: name } : sel;
}

export interface SecretGroup {
  key: string;
  vault: string;
  item: string;
  rows: SecretCandidate[];
}

/** Groups the candidates by 1Password item and keeps those that match the filter. */
export function groupCandidates(
  candidates: readonly SecretCandidate[],
  filter: string,
): SecretGroup[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<string, SecretGroup>();
  for (const c of candidates) {
    const hay =
      `${c.vault} ${c.item} ${c.section ?? ""} ${c.field} ${c.suggestedName}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const key = `${c.vault}/${c.itemId}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, vault: c.vault, item: c.item, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(c);
  }
  return [...groups.values()];
}

/** Ticked references that 1Password no longer lists, and global references are not among them. */
export function missingRefs(
  sel: SecretSelection,
  candidates: readonly SecretCandidate[],
): { ref: string; name: string }[] {
  const known = new Set(candidates.map((c) => c.ref));
  return Object.entries(sel)
    .filter(([ref]) => !known.has(ref))
    .map(([ref, name]) => ({ ref, name }));
}

/** Why the selection can't be saved. Empty when it can. */
export function secretProblems(sel: SecretSelection): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [ref, name] of Object.entries(sel)) {
    if (!EnvVarNameSchema.safeParse(name).success) {
      problems.push(
        `The secret name "${name}" for ${ref} must start with a letter or underscore and use only letters, digits, and underscores.`,
      );
    } else if (seen.has(name)) {
      problems.push(`The secret name ${name} is used twice.`);
    }
    seen.add(name);
  }
  return problems;
}

/**
 * The project's references to save, or `null` when the selection matches the
 * saved ones. Saved references keep their order and new ones follow.
 */
export function refsToSave(sel: SecretSelection, saved: readonly SecretRef[]): SecretRef[] | null {
  const kept = saved.filter((r) => r.ref in sel).map((r) => ({ name: sel[r.ref]!, ref: r.ref }));
  const savedRefs = new Set(saved.map((r) => r.ref));
  const added = Object.entries(sel)
    .filter(([ref]) => !savedRefs.has(ref))
    .map(([ref, name]) => ({ name, ref }));
  const next = [...kept, ...added];
  const same =
    next.length === saved.length &&
    next.every((r, i) => r.name === saved[i]!.name && r.ref === saved[i]!.ref);
  return same ? null : next;
}
