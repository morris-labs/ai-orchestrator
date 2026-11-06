// Verdict quality: related findings, the dedup pass, severity anchors, the
// trust rule, and the root-cause summary.
import { FindingSchema, fromVendorFinding, introducedLabel, type Finding } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { VerifyOutputSchema } from "../../src/core.js";
import {
  SEVERITY_ANCHORS,
  TRUST_RULE,
  batchDisproverPrompt,
  clusterPrompt,
  disproverPrompt,
  finderPrompt,
} from "../../src/prompts/templates.js";
import { relatedFindings, rootCauseDuplicates } from "../../src/verify/batch.js";
import { decideVerdict } from "../../src/verify/verify.js";
import { rootCausesFrom } from "../../src/state/steps.js";

const TIP = "b".repeat(40);
const range = { repoPath: "/repo", baseSha: "aaaaaaa", tipSha: "bbbbbbb", tipRef: "feature" };

function make(n: number, title: string, lines: [number, number], failure: string): Finding {
  const f = fromVendorFinding(
    {
      severity: "P2",
      title,
      file: "shop/auth.py",
      lines,
      failure_case: failure,
      category: "security",
      introduced: true,
      verdict: "pending",
    },
    {
      id: `F-${String(n).padStart(4, "0")}`,
      fingerprint: `fp-${n}`,
      reportedBy: "codex-gpt",
      runId: "01JB0000000000000000000001",
      round: 1,
      groupId: "G01",
      linesAt: TIP,
    },
  );
  return f;
}

const token = make(
  1,
  "Shared install token grants every tenant write access",
  [10, 12],
  "Any tenant's install token writes another tenant's rows.",
);
const tokenAgain = make(
  2,
  "Install token shared by every tenant allows writes",
  [14, 15],
  "Any tenant's install token writes another tenant's rows.",
);
const unrelated = make(
  3,
  "Log line omits the request id",
  [30, 31],
  "A failed request can't be traced.",
);
const far = make(
  4,
  "Session cookie lacks the secure flag",
  [200, 201],
  "The cookie travels over plain HTTP.",
);

describe("the dedup pass", () => {
  it("folds a finding with the same root cause at an adjacent location", () => {
    const dups = rootCauseDuplicates([token, tokenAgain, unrelated, far]);
    expect([...dups]).toEqual([["F-0002", "F-0001"]]);
  });
});

describe("related findings", () => {
  it("lists nearby findings in the same file, nearest first, and skips far ones", () => {
    expect(relatedFindings([token], [token, tokenAgain, unrelated, far]).map((f) => f.id)).toEqual([
      "F-0002",
      "F-0003",
    ]);
  });

  it("puts related findings and the consistency rule in both disprover prompts", () => {
    const confirmed = { ...tokenAgain, verdict: "confirmed" as const };
    const one = disproverPrompt({
      range,
      finding: token,
      scratchDir: "/s",
      baseWorktree: null,
      policySection: "",
      related: [confirmed],
    });
    expect(one).toContain("## Related findings");
    expect(one).toContain("F-0002 [confirmed]");
    const batch = batchDisproverPrompt({
      range,
      findings: [token],
      scratchDir: "/s",
      baseWorktree: null,
      policySection: "",
      related: [confirmed],
    });
    expect(batch).toContain("same verdict");
    expect(batch).toContain("F-0002 [confirmed]");
  });
});

describe("prompt rules", () => {
  it("gives disprovers the trust rule and the severity anchors", () => {
    const full = disproverPrompt({
      range,
      finding: token,
      scratchDir: "/s",
      baseWorktree: null,
      policySection: "",
    });
    expect(full).toContain(TRUST_RULE);
    expect(full).toContain(SEVERITY_ANCHORS[0]);
    const terse = disproverPrompt({
      range,
      finding: token,
      scratchDir: "/s",
      baseWorktree: null,
      policySection: "",
      standard: true,
    });
    expect(terse).toMatch(/needs code evidence of how the credential is issued and scoped/);
    expect(terse).toMatch(/cross-tenant access/);
  });

  it("gives reviewers the severity anchors", () => {
    const input = {
      range,
      round: 1,
      groupId: "G01",
      files: ["shop/auth.py"],
      hunks: [],
      diff: "",
      focusAreas: null,
      findingsLog: [],
      policySection: "",
    };
    expect(finderPrompt(input)).toContain(SEVERITY_ANCHORS[0]);
    expect(finderPrompt({ ...input, standard: true })).toMatch(/cross-tenant access/);
  });
});

describe("severity and introduced in the verdict", () => {
  const confirmed = VerifyOutputSchema.parse({
    verdict: "confirmed",
    verification: "code-reading",
    evidence: "The token is shared by every install.",
    severity: "P1",
  });

  it("carries the disprover's severity on a confirmed verdict", () => {
    expect(decideVerdict(confirmed, null, null).severity).toBe("P1");
  });

  it("records introduced as unknown when the run has no base", () => {
    expect(decideVerdict(confirmed, null, null, [], true).introduced).toBeNull();
    expect(decideVerdict(confirmed, null, null, [], false).introduced).toBe(true);
  });

  it("parses stored findings with a boolean or null introduced, and labels both", () => {
    expect(FindingSchema.parse({ ...token, introduced: null }).introduced).toBeNull();
    expect(FindingSchema.parse(token).introduced).toBe(true);
    expect(introducedLabel(null)).toMatch(/Unknown/);
    expect(introducedLabel(false)).toMatch(/base/);
  });
});

describe("the root-cause summary", () => {
  it("asks for clusters from titles, failure cases, and locations only", () => {
    const prompt = clusterPrompt({ findings: [token, unrelated] });
    expect(prompt).toContain("F-0001 P2 shop/auth.py:10-12");
    expect(prompt).toContain("Don't read or run anything");
  });

  it("drops unknown ids, places missed findings, adds duplicates, and renumbers", () => {
    const dup = { ...tokenAgain, duplicateOf: "F-0001" };
    const causes = rootCausesFrom(
      {
        causes: [
          { title: "Logging", summary: "", findingIds: ["F-0003"], fixOrder: 5 },
          {
            title: "Shared token",
            summary: "One token for all",
            findingIds: ["F-0001", "F-9999"],
            fixOrder: 1,
          },
          { title: "Empty", summary: "", findingIds: ["F-9998"], fixOrder: 2 },
        ],
        rationale: "Cross-tenant first.",
      },
      [token, unrelated, far],
      [token, dup, unrelated, far],
    );
    expect(causes).toEqual([
      {
        title: "Shared token",
        summary: "One token for all",
        findingIds: ["F-0001", "F-0002"],
        fixOrder: 1,
      },
      { title: "Logging", summary: "", findingIds: ["F-0003"], fixOrder: 2 },
      { title: far.title, summary: "", findingIds: ["F-0004"], fixOrder: 3 },
    ]);
  });
});
