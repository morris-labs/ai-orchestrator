import { adaptLegacyFinding, type Finding, type VendorFinding } from "@aio/contracts";
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
const TIP = "1111111111111111111111111111111111111111";

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
    linesAt: TIP,
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

  it("tells apart titles with no Latin words", () => {
    expect(normalizeTitle("Деление на ноль в `total`")).toBe("деление на ноль total");
    expect(titleSimilarity("Деление на ноль", "Утечка памяти")).toBe(0);
    expect(titleSimilarity("404", "500")).toBe(0);
    expect(fingerprint("a.py", "f", "Деление на ноль")).not.toBe(
      fingerprint("a.py", "f", "Утечка памяти"),
    );
    expect(fingerprint("a.py", "f", "404")).not.toBe(fingerprint("a.py", "f", "500"));
    expect(fingerprint("a.py", "f", "404 !")).toBe(fingerprint("a.py", "f", "404  !"));
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

  it("keeps two findings on the same lines whose titles have no Latin words apart", () => {
    const result = mergeCandidates(
      [],
      [
        cand(raw("Деление на ноль при пустом списке"), "codex-gpt"),
        cand(raw("Утечка памяти в обработчике", "a.py", [11, 11]), "claude-opus"),
        cand(raw("123"), "codex-gpt"),
        cand(raw("456", "a.py", [11, 11]), "claude-opus"),
      ],
      ctx(),
    );
    expect(result.created).toHaveLength(4);
    expect(result.duplicates).toHaveLength(0);
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
      linesAt: TIP,
      title: "SQL injection in the order lookup",
      failureCase: "A quote in the order id ends the string and runs a second statement.",
    };
    const other = { ...base, fingerprint: "y" };
    // Overlapping lines alone don't make two findings one issue.
    expect(
      sameIssue(base, { ...other, title: "Wrong total", failureCase: "The total drops tax." }),
    ).toBe(false);
    // A similar title or a similar failure case does.
    expect(sameIssue(base, { ...other, title: "Order lookup SQL injection" })).toBe(true);
    expect(sameIssue(base, { ...other, title: "Unescaped input" })).toBe(true);
    expect(sameIssue(base, { ...other, title: "Unescaped input", failureCase: "" })).toBe(false);
    // Lines in another version of the file aren't compared; the fingerprint still is.
    expect(sameIssue(base, { ...other, linesAt: "2".repeat(40) })).toBe(false);
    expect(sameIssue(base, { ...other, linesAt: undefined })).toBe(false);
    expect(sameIssue(base, { ...base, linesAt: "2".repeat(40), lines: [90, 99] })).toBe(true);
    // Lines within NEAR_LINE_GAP of each other count as one location; farther ones don't.
    expect(sameIssue(base, { ...other, lines: [4, 9] })).toBe(true);
    expect(sameIssue(base, { ...other, lines: [8, 12] })).toBe(false);
  });

  it("keeps unrelated findings in one category whose lines overlap", () => {
    const loop = raw("Off-by-one in SYNTHETIC_loop", "a.py", [10, 60]);
    const sql = raw("SQL built from unescaped input", "a.py", [40, 42]);
    const result = mergeCandidates([], [cand(loop, "codex-gpt"), cand(sql, "copilot-auto")], ctx());
    expect(result.created).toEqual(["F-0001", "F-0002"]);
    expect(result.duplicates).toEqual([]);

    // A waived finding doesn't hide an unrelated one on the same lines.
    const waived: Finding[] = [{ ...result.findings[0]!, verdict: "waived" }];
    const again = mergeCandidates(waived, [cand(sql, "copilot-auto", "g")], {
      ...ctx(),
      nextId: () => "F-0003",
    });
    expect(again.known).toEqual([]);
    expect(again.created).toEqual(["F-0003"]);
  });

  it("compares lines only within the tip they were raised on", () => {
    const first = mergeCandidates(
      [],
      [cand(raw("Divide by zero on empty list", "a.py", [10, 12]), "codex-gpt")],
      ctx(),
    );
    expect(first.findings[0]?.linesAt).toBe(TIP);
    const moved = mergeCandidates(
      first.findings,
      [cand(raw("Empty list divides by zero", "a.py", [11, 11]), "copilot-auto", "g")],
      { ...ctx(), linesAt: "2".repeat(40), nextId: () => "F-0002" },
    );
    expect(moved.created).toEqual(["F-0002"]);
    const same = mergeCandidates(
      first.findings,
      [cand(raw("Empty list divides by zero", "a.py", [11, 11]), "copilot-auto", "g")],
      { ...ctx(), nextId: () => "F-0002" },
    );
    expect(same.created).toEqual([]);
    expect(same.duplicates).toHaveLength(1);
  });

  it("merges a later candidate into a reopened finding instead of treating it as closed", () => {
    const candidate = cand(raw("Cart loses the discount"), "codex-test");
    const first = mergeCandidates([], [candidate], ctx()).findings[0]!;
    const reopened = adaptLegacyFinding({ ...first, verdict: "pre-existing", introduced: false });
    const later = mergeCandidates([reopened], [{ ...candidate, reportedBy: "copilot-test" }], {
      ...ctx(),
      round: 2,
    });
    expect(later.created).toEqual([]);
    expect(later.known).toEqual([]);
    expect(later.duplicates).toEqual([
      { reportedBy: "copilot-test", title: "Cart loses the discount", into: first.id },
    ]);
    expect(later.findings).toHaveLength(1);
    expect(later.findings[0]).toMatchObject({
      id: first.id,
      verdict: "confirmed",
      introduced: false,
    });
    expect(findingsLog(later.findings)).toEqual([]);
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
