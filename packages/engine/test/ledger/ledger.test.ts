import type { Hunk } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import {
  findingTouchesHunk,
  hunksForFinding,
  missingHunks,
  newLedger,
  recordVerdicts,
} from "../../src/ledger/ledger.js";

const hunks: Hunk[] = [
  { id: "G01-H01", file: "a.py", start: 10, end: 14 },
  { id: "G01-H02", file: "a.py", start: 30, end: 30 },
  { id: "G01-H03", file: "b.py", start: 1, end: 3 },
];

describe("ledger", () => {
  it("maps findings to the hunks they touch", () => {
    expect(hunksForFinding({ file: "a.py", lines: [12, 40] }, hunks)).toEqual([
      "G01-H01",
      "G01-H02",
    ]);
    expect(findingTouchesHunk({ file: "a.py", lines: [31, 31] }, hunks[1] as Hunk)).toBe(true);
    expect(findingTouchesHunk({ file: "b.py", lines: [12, 12] }, hunks[0] as Hunk)).toBe(false);
  });

  it("records verdicts and finds hunks without one", () => {
    let ledger = newLedger("G01", hunks);
    expect(missingHunks(ledger, hunks)).toHaveLength(3);
    ledger = recordVerdicts(
      ledger,
      hunks,
      "codex",
      [
        { hunkId: "G01-H01", verdict: "sound", reason: "fine" },
        { hunkId: "nope", verdict: "sound", reason: "" },
      ],
      [{ file: "b.py", lines: [2, 2], title: "bad" }],
    );
    expect(ledger.entries.map((e) => e.verdict)).toEqual(["sound", "missing", "findings"]);
    expect(missingHunks(ledger, hunks).map((h) => h.id)).toEqual(["G01-H02"]);
    // A later finding overrides an earlier "sound".
    ledger = recordVerdicts(
      ledger,
      hunks,
      "copilot",
      [],
      [{ file: "a.py", lines: [11, 11], title: "x" }],
    );
    expect(ledger.entries[0]).toMatchObject({
      verdict: "findings",
      reviewers: ["codex", "copilot"],
    });
  });

  it("explains a sound-marked hunk that a finding touches with the finding's title", () => {
    const ledger = recordVerdicts(
      newLedger("G01", hunks),
      hunks,
      "codex",
      [
        { hunkId: "G01-H01", verdict: "sound", reason: "Examined; nothing is wrong." },
        { hunkId: "G01-H03", verdict: "findings", reason: "The loop skips the last item." },
      ],
      [
        { file: "a.py", lines: [12, 12], title: "Off-by-one in the total" },
        { file: "b.py", lines: [2, 2], title: "Skips the last item" },
      ],
    );
    expect(ledger.entries[0]).toMatchObject({
      verdict: "findings",
      reason: "Off-by-one in the total",
    });
    expect(ledger.entries[2]).toMatchObject({
      verdict: "findings",
      reason: "The loop skips the last item.",
    });
  });
});
