import { describe, expect, it } from "vitest";
import {
  exportFileName,
  findingsHtml,
  findingsJson,
  findingsMarkdown,
  type FindingsExport,
} from "../src/screens/findingsExport.js";
import { demoFindings, lastRun } from "./helpers/data.js";

const run = { ...lastRun(), prUrl: "https://github.com/octo/app/pull/12", prNumber: 12 };

function sample(): FindingsExport {
  const findings = demoFindings();
  const [first, ...rest] = findings;
  return {
    run,
    exportedAt: "2026-01-02T03:04:05.000Z",
    findings: [
      {
        finding: {
          ...first!,
          title: "Breaks </script><img src=x onerror=alert(1)>",
          evidence: "a ``` fence",
          externalRef: { url: "javascript:alert(1)" } as never,
        },
        diff: "@@ -1 +1 @@\n-old\n+new",
        fixDiff: null,
      },
      ...rest.map((finding) => ({ finding, diff: null, fixDiff: null })),
    ],
  };
}

describe("findings export", () => {
  it("names files after the repository and run", () => {
    expect(exportFileName(run, "html")).toMatch(
      /^findings-[A-Za-z0-9._-]+-[A-Za-z0-9._-]{1,8}\.html$/,
    );
  });

  it("writes every finding with its diffs as JSON, most severe first", () => {
    const parsed = JSON.parse(findingsJson(sample())) as {
      findings: { severity: string; diff: string | null }[];
    };
    expect(parsed.findings).toHaveLength(demoFindings().length);
    const order = { P1: 0, P2: 1, P3: 2, nit: 3 } as Record<string, number>;
    const ranks = parsed.findings.map((f) => order[f.severity]!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(parsed.findings.some((f) => f.diff?.includes("+new"))).toBe(true);
  });

  it("fences evidence with more backticks than it holds", () => {
    const md = findingsMarkdown(sample());
    expect(md).toContain("# Findings for");
    expect(md).toContain("````\na ``` fence\n````");
    expect(md).toContain("```diff\n@@ -1 +1 @@");
  });

  it("builds one HTML file that can't be broken out of", () => {
    const html = findingsHtml(sample());
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    // The title appears only in escaped JSON, so it can't close the script.
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script>");
    expect(html).toContain(`"sourceLink":null`);
    expect(html).not.toMatch(/<(link|script)[^>]+src=/);
    expect(html).toContain("Content-Security-Policy");
  });

  it("lists, filters, and opens findings in the exported page", async () => {
    const html = findingsHtml(sample());
    const doc = new DOMParser().parseFromString(html, "text/html");
    document.documentElement.innerHTML = doc.documentElement.innerHTML;
    const script = [...document.querySelectorAll("script:not([type])")][0]!.textContent!;
    new Function(script)();
    const total = demoFindings().length;
    expect(document.getElementById("count")!.textContent).toBe(`${total} of ${total} findings`);
    const severity = document.getElementById("f-severity") as HTMLSelectElement;
    severity.value = "P1";
    severity.dispatchEvent(new Event("change"));
    const p1 = demoFindings().filter((f) => f.severity === "P1").length;
    expect(document.getElementById("count")!.textContent).toBe(`${p1} of ${total} findings`);
    const row = document.querySelector<HTMLButtonElement>(".finding-row")!;
    row.click();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const detail = document.querySelector("article.finding-detail")!;
    expect(detail).not.toBeNull();
    expect(detail.querySelector("img")).toBeNull();
    expect(detail.querySelector(`a[href^="javascript"]`)).toBeNull();
    location.hash = "";
  });
});
