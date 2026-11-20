// Filtering for the findings browser.
import type { Finding, Severity, Vendor, Verdict } from "@aio/contracts";
import { vendorOfLabel } from "./runModel.js";

export interface FindingFilter {
  round: number | null;
  vendor: Vendor | null;
  severity: Severity | null;
  verdict: Verdict | null;
}

export const NO_FILTER: FindingFilter = {
  round: null,
  vendor: null,
  severity: null,
  verdict: null,
};

/** The vendors that raised a finding, including those merged into it. */
export function findingVendors(f: Finding): Vendor[] {
  const out = new Set<Vendor>();
  for (const label of [f.reportedBy, ...f.alsoReportedBy]) {
    const v = vendorOfLabel(label);
    if (v) out.add(v);
  }
  return [...out];
}

const SEVERITY_ORDER: Record<Severity, number> = { P1: 0, P2: 1, P3: 2, nit: 3 };

export function filterFindings(findings: readonly Finding[], filter: FindingFilter): Finding[] {
  return findings
    .filter(
      (f) =>
        (filter.round === null || f.round === filter.round) &&
        (filter.severity === null || f.severity === filter.severity) &&
        (filter.verdict === null || f.verdict === filter.verdict) &&
        (filter.vendor === null || findingVendors(f).includes(filter.vendor)),
    )
    .sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
    );
}

/** A finding can be waived until it is fixed, disproved, or already waived. */
export function canWaive(f: Finding): boolean {
  return f.verdict === "pending" || f.verdict === "confirmed";
}

/** How a finding that the verification floor kept from a disprover reads. */
export const NOT_VERIFIED_LABEL = "not verified: below the verification floor";

/** How a confirmed finding that the verification floor kept from the fixer reads. */
export const FIX_HELD_LABEL = "not sent to the fixer: below the verification floor";
