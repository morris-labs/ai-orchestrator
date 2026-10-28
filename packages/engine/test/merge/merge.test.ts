import type { Finding, VendorFinding } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import {
  enclosingSymbol,
  fingerprint,
  normalizeTitle,
  titleSimilarity,
} from "../../src/merge/fingerprint.js";
import {
  findingsLog,
  linesOverlap,
  mergeCandidates,
  moreSevere,
  sameIssue,
  type Candidate,
} from "../../src/merge/merge.js";

const RUN = "01JB0000000000000000000001";

function raw(
  title: string,
  file = "a.py",
  lines: [number, number] = [10, 12],
  category = "correctness",
): VendorFinding {
  return {
    severity: "P2",
    title,
    file,
    lines,
    failure_case: "x",
    category,
    introduced: true,
    verdict: "pending",
  };
}

function cand(r: VendorFinding, reportedBy: string, symbol = "f"): Candidate {
  return {
    raw: r,
    reportedBy,
    vendor: reportedBy.split("-")[0] as Candidate["vendor"],
    groupId: "G01",
    hunkIds: ["G01-H01"],
    origin: "reviewer",
    fingerprint: fingerprint(r.file, symbol, r.title),
    symbol,
  };
}

function ctx() {
  let n = 0;
  return {
    runId: RUN,
    round: 1,
    nextId: () => `F-${String(++n).padStart(4, "0")}`,
    now: () => "2026-10-28T09:00:00.000Z",
  };
}

describe("fingerprint", () => {
  it("normalizes titles", () => {
    expect(normalizeTitle("The `parse()` crashes on 2 empty inputs!")).toBe(
      "parse crashes empty inputs",
    );
    expect(fingerprint("a.py", "f", "Crash on empty input")).toBe(
      fingerprint("a.py", "f", "crash on EMPTY input."),
    );
    expect(fingerprint("a.py", "g", "Crash on empty input")).not.toBe(
      fingerprint("a.py", "f", "Crash on empty input"),
    );
    expect(titleSimilarity("divide by zero on empty list", "empty list divide by zero")).toBe(1);
  });

  it("finds the enclosing symbol", () => {
    const py = "class Cart:\n    def total(self):\n        x = 1\n        return x\n";
    expect(enclosingSymbol(py, 4)).toBe("total");
    expect(enclosingSymbol(py, 1)).toBe("Cart");
    const ts = "export async function load(a) {\n  if (a) {\n    return 1;\n  }\n}\n";
    expect(enclosingSymbol(ts, 3)).toBe("load");
    expect(enclosingSymbol("const go = (x) => {\n  x();\n};", 2)).toBe("go");
    expect(enclosingSymbol(null, 3)).toBe("");
  });
});

describe("merge", () => {
  it("dedupes by fingerprint and by overlapping lines, and computes the overlap rate", () => {
    const result = mergeCandidates(
      [],
      [
        cand(raw("Divide by zero on empty list"), "copilot-auto"),
        cand(raw("Empty list divides by zero", "a.py", [11, 11]), "codex-gpt"),
        cand(raw("Unrelated leak", "a.py", [40, 41], "resource"), "codex-gpt"),
        cand(raw("Divide by zero on empty list"), "copilot-auto"),
      ],
      ctx(),
    );
    expect(result.created).toEqual(["F-0001", "F-0002"]);
    expect(result.findings[0]?.alsoReportedBy).toEqual(["codex-gpt"]);
    expect(result.duplicates).toHaveLength(2);
    expect(result.overlapRate).toBe(0.5);
  });

  it("drops candidates that match a closed verdict and flags a fixed finding that returns", () => {
    const first = mergeCandidates(
      [],
      [cand(raw("Bad check"), "codex-gpt"), cand(raw("Leak", "b.py"), "codex-gpt")],
      ctx(),
    );
    const existing: Finding[] = first.findings.map((f, i) => ({
      ...f,
      verdict: i === 0 ? "fixed" : "disproved",
    }));
    const c = ctx();
    c.nextId = () => "F-0009";
    const again = mergeCandidates(
      existing,
      [
        cand(raw("Bad check", "a.py", [50, 50]), "copilot-auto"),
        cand(raw("Leak", "b.py"), "copilot-auto"),
      ],
      c,
    );
    expect(again.known).toEqual([{ reportedBy: "copilot-auto", title: "Leak", matches: "F-0002" }]);
    expect(again.oscillations).toEqual([{ fixedId: "F-0001", returnedId: "F-0009" }]);
    const accepted = mergeCandidates(
      existing,
      [cand(raw("Bad check", "a.py", [50, 50]), "copilot-auto")],
      {
        ...ctx(),
        acceptedOscillations: ["F-0001"],
      },
    );
    expect(accepted.oscillations).toEqual([]);
    expect(accepted.created).toHaveLength(1);
  });

  it("keeps the most severe severity on a duplicate", () => {
    const a = raw("Bad check");
    const b = { ...raw("Bad check"), severity: "P1" as const };
    const result = mergeCandidates([], [cand(a, "codex-gpt"), cand(b, "copilot-auto")], ctx());
    expect(result.findings[0]?.severity).toBe("P1");
    expect(moreSevere("nit", "P3")).toBe("P3");
  });

  it("compares issues", () => {
    expect(linesOverlap([1, 5], [5, 9])).toBe(true);
    expect(linesOverlap([1, 4], [5, 9])).toBe(false);
    expect(linesOverlap(null, [1, 1])).toBe(false);
    const base = {
      fingerprint: "x",
      file: "a",
      lines: [1, 3] as [number, number],
      category: "security",
      title: "SQL injection",
    };
    expect(
      sameIssue(base, { ...base, fingerprint: "y", category: "correctness", title: "wrong total" }),
    ).toBe(false);
    expect(sameIssue(base, { ...base, fingerprint: "y", title: "wrong total" })).toBe(true);
  });

  it("builds the findings log from closed findings", () => {
    const { findings } = mergeCandidates(
      [],
      [cand(raw("A"), "codex-gpt"), cand(raw("B", "b.py"), "codex-gpt")],
      ctx(),
    );
    const closed: Finding[] = [
      { ...findings[0]!, verdict: "disproved", evidence: "The guard   on line 3 rejects it." },
      findings[1]!,
    ];
    expect(findingsLog(closed)).toEqual([
      {
        id: "F-0001",
        verdict: "disproved",
        severity: "P2",
        title: "A",
        file: "a.py",
        lines: [10, 12],
        reason: "The guard on line 3 rejects it.",
      },
    ]);
  });
});
