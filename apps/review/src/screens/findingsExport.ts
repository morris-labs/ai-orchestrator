// Exports of a run's findings: JSON for tools, Markdown for a person or
// another agent to read, and a single HTML file that works like the findings
// screen with no server behind it.
import {
  introducedLabel,
  type Finding,
  type RootCause,
  type RunState,
  type Severity,
} from "@aio/contracts";
import { themeCss, VENDOR_LABELS } from "@aio/ui/dashboard";
import {
  filterFindings,
  findingVendors,
  FIX_HELD_LABEL,
  NO_FILTER,
  NOT_VERIFIED_LABEL,
} from "./findingsModel.js";
import { commitUrl } from "./runModel.js";

/** A finding with the diffs that `findings.get` returns. */
export interface ExportedFinding {
  finding: Finding;
  diff: string | null;
  fixDiff: string | null;
}

export interface FindingsExport {
  run: RunState;
  findings: readonly ExportedFinding[];
  /** When the export was made, as an ISO time. */
  exportedAt: string;
}

export type ExportFormat = "json" | "markdown" | "html";

export const EXPORT_FORMATS: Record<
  ExportFormat,
  { label: string; extension: string; mime: string }
> = {
  json: { label: "JSON", extension: "json", mime: "application/json" },
  markdown: { label: "Markdown", extension: "md", mime: "text/markdown" },
  html: { label: "HTML report", extension: "html", mime: "text/html" },
};

/** The findings in the order the screen lists them: severity, then ID. */
function ordered(findings: readonly ExportedFinding[]): ExportedFinding[] {
  const byId = new Map(findings.map((f) => [f.finding.id, f]));
  return filterFindings(
    findings.map((f) => f.finding),
    NO_FILTER,
  ).map((f) => byId.get(f.id) as ExportedFinding);
}

/** The last part of the run's repository path, for file names and titles. */
export function repoName(run: RunState): string {
  const parts = run.request.repoPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "repository";
}

/** A file name such as `findings-app-1a2b3c4d.html`. */
export function exportFileName(run: RunState, format: ExportFormat): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `findings-${safe(repoName(run)) || "run"}-${safe(run.id).slice(0, 8)}.${EXPORT_FORMATS[format].extension}`;
}

function location(f: Finding): string {
  return `${f.file ?? "No location"}${f.lines ? `:${f.lines[0]}-${f.lines[1]}` : ""}`;
}

function verdictText(f: Finding): string {
  return [
    f.verdict,
    f.verification ? ` (${f.verification})` : "",
    f.unverifiedReason ? ` (${NOT_VERIFIED_LABEL})` : "",
    f.followUpReason ? " (needs follow-up: no vendor would check it)" : "",
    f.fixHeldReason ? ` (${FIX_HELD_LABEL})` : "",
    f.floorBypassReason ? ` (below the floor: ${f.floorBypassReason})` : "",
  ].join("");
}

/** The run's root causes in the suggested fix order, or none when the run has no summary. */
function rootCauses(run: RunState): RootCause[] {
  return [...(run.rootCauses?.causes ?? [])].sort((a, b) => a.fixOrder - b.fixOrder);
}

function counts(findings: readonly ExportedFinding[]): string {
  const by = new Map<Severity, number>();
  for (const { finding } of findings) by.set(finding.severity, (by.get(finding.severity) ?? 0) + 1);
  const parts = (["P1", "P2", "P3", "nit"] as const)
    .filter((s) => by.has(s))
    .map((s) => `${by.get(s)} ${s}`);
  return `${findings.length} findings${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** The run and every finding with its diffs, as JSON. */
export function findingsJson(e: FindingsExport): string {
  return `${JSON.stringify(
    {
      exportedAt: e.exportedAt,
      run: e.run,
      // Also inside `run`; repeated here so a reader finds it next to the findings.
      rootCauses: e.run.rootCauses ?? null,
      findings: ordered(e.findings).map((f) => ({
        ...f.finding,
        diff: f.diff,
        fixDiff: f.fixDiff,
      })),
    },
    null,
    2,
  )}\n`;
}

/** A code fence longer than any run of backticks in the text. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

/** The findings as Markdown, for a person or another agent to read. */
export function findingsMarkdown(e: FindingsExport): string {
  const { run } = e;
  const out: string[] = [
    `# Findings for ${repoName(run)}`,
    "",
    `- Run: \`${run.id}\` (${run.status})`,
    `- Repository: \`${run.request.repoPath}\``,
    `- Base: \`${run.request.base}\`${run.request.tip ? `, tip: \`${run.request.tip}\`` : ""}`,
    ...(run.prUrl ? [`- Pull request: ${run.prUrl}`] : []),
    `- Started: ${run.createdAt}`,
    `- Exported: ${e.exportedAt}`,
    `- ${counts(e.findings)}`,
  ];
  if (run.rootCauses) {
    out.push("", "## Root causes", "");
    const causes = rootCauses(run);
    if (causes.length === 0) out.push("No root causes were found.");
    for (const c of causes)
      out.push(
        `${c.fixOrder}. **${c.title}**${c.summary ? `: ${c.summary.replace(/\s+/g, " ")}` : ""}`,
        `   Findings: ${c.findingIds.join(", ")}`,
      );
    if (run.rootCauses.rationale) out.push("", run.rootCauses.rationale);
  }
  for (const { finding: f, diff, fixDiff } of ordered(e.findings)) {
    out.push(
      "",
      `## ${f.id} [${f.severity}] ${f.title}`,
      "",
      `- Location: \`${location(f)}\`${f.symbol ? ` in \`${f.symbol}\`` : ""}`,
      `- Category: ${f.category}, round ${f.round}, group ${f.groupId ?? "none"}`,
      `- Verdict: ${verdictText(f)}`,
      `- Raised by: ${[f.reportedBy, ...f.alsoReportedBy].join(", ")}`,
      `- Introduced: ${introducedLabel(f.introduced)}`,
      ...(f.duplicateOf ? [`- Duplicate of: ${f.duplicateOf}`] : []),
      ...(f.fixCommit ? [`- Fix commit: \`${f.fixCommit}\``] : []),
      "",
      "### Failure case",
      "",
      f.failureCase || "None recorded.",
    );
    if (f.evidence) out.push("", "### Evidence", "", fence(f.evidence));
    if (diff) out.push("", "### Diff", "", fence(diff, "diff"));
    if (fixDiff) out.push("", "### Fix", "", fence(fixDiff, "diff"));
    if (f.history.length > 0) {
      out.push("", "### Verdict trail", "");
      for (const h of f.history) {
        const who = [h.actor.kind, h.actor.vendor, h.actor.role ? `(${h.actor.role})` : ""]
          .filter(Boolean)
          .join(" ");
        out.push(
          `1. ${h.verdict} by ${who}${h.round ? `, round ${h.round}` : ""}, ${h.time}${h.evidence ? `: ${h.evidence.replace(/\s+/g, " ")}` : ""}`,
        );
      }
    }
  }
  return `${out.join("\n")}\n`;
}

/** Only web links become links in the report; anything else stays text. */
function webLink(url: string | undefined | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** JSON that is safe inside a `<script>` element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const REPORT_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--ab-page); color: var(--ab-text); font-family: var(--ab-font); font-size: 14px; }
a { color: var(--ab-accent); }
.mono, code { font-family: var(--ab-mono); font-size: 12px; }
.muted { color: var(--ab-muted); }
.small { font-size: 12px; }
.screen { padding: 16px 24px; display: grid; gap: 12px; max-width: 1600px; margin: 0 auto; }
h2 { margin: 0; font-size: 18px; }
h3 { margin: 0 0 6px; font-size: 15px; }
h4 { margin: 12px 0 6px; font-size: 13px; color: var(--ab-text-2); }
.run-facts { margin: 0; }
.card { background: var(--ab-surface); border: 1px solid var(--ab-border); border-radius: 8px; padding: 12px 16px; }
.filter-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
.field { display: grid; gap: 4px; }
.field-label { color: var(--ab-text-2); font-size: 12px; }
button, select, input { font: inherit; background: var(--ab-surface-2); color: var(--ab-text); border: 1px solid var(--ab-border); border-radius: 6px; padding: 6px 12px; }
button { cursor: pointer; }
.split { display: grid; grid-template-columns: minmax(240px, 2fr) minmax(0, 3fr); gap: 12px; align-items: start; }
.detail-pane { position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow: auto; }
.finding-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.finding-row { width: 100%; text-align: left; display: grid; gap: 2px; background: var(--ab-surface); }
.finding-row.selected { border-color: var(--ab-accent); }
.finding-title { overflow-wrap: anywhere; }
.sev { font-size: 11px; font-weight: 700; border-radius: 4px; padding: 0 5px; border: 1px solid var(--ab-border); }
.sev-P1 { color: var(--ab-critical); }
.sev-P2 { color: var(--ab-serious); }
.sev-P3 { color: var(--ab-warning); }
.sev-nit { color: var(--ab-muted); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.facts dt { color: var(--ab-text-2); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.evidence, .diff { background: var(--ab-surface-2); border-radius: 6px; padding: 8px; overflow-x: auto; font-family: var(--ab-mono); font-size: 12px; margin: 0; white-space: pre; }
.evidence { white-space: pre-wrap; }
.diff-add { color: var(--ab-good); }
.diff-del { color: var(--ab-critical); }
.diff-hunk { color: var(--ab-accent); }
.diff-file { color: var(--ab-text-2); font-weight: 600; }
.trail { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
.root-causes { display: grid; gap: 6px; }
p { margin: 0; white-space: pre-wrap; }
@media (max-width: 860px) { .split { grid-template-columns: 1fr; } .detail-pane { position: static; max-height: none; } }
@media print { .filter-row { display: none; } .split { grid-template-columns: 1fr; } .detail-pane { position: static; max-height: none; } }
`;

// The report's own script. It builds every element with textContent, so no
// text from a finding is ever parsed as HTML.
const REPORT_SCRIPT = `
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("findings-data").textContent);
  var all = data.findings;
  var filter = { round: "", vendor: "", severity: "", verdict: "" };
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "className") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function link(url, text, cls) {
    return url ? el("a", { href: url, target: "_blank", rel: "noreferrer", className: cls || "", text: text }) : el("span", { className: cls || "", text: text });
  }
  function options(select, values) {
    select.appendChild(el("option", { value: "", text: "All" }));
    values.forEach(function (v) { select.appendChild(el("option", { value: v[0], text: v[1] })); });
  }
  function uniq(list) { return list.filter(function (v, i) { return list.indexOf(v) === i; }); }
  var rounds = uniq(all.map(function (f) { return f.finding.round; })).sort(function (a, b) { return a - b; });
  var vendors = uniq([].concat.apply([], all.map(function (f) { return f.vendors; }))).sort();
  var severities = ["P1", "P2", "P3", "nit"].filter(function (s) { return all.some(function (f) { return f.finding.severity === s; }); });
  var verdicts = uniq(all.map(function (f) { return f.finding.verdict; })).sort();
  var selects = {
    round: document.getElementById("f-round"),
    vendor: document.getElementById("f-vendor"),
    severity: document.getElementById("f-severity"),
    verdict: document.getElementById("f-verdict")
  };
  options(selects.round, rounds.map(function (r) { return [String(r), String(r)]; }));
  options(selects.vendor, vendors.map(function (v) { return [v, data.vendorLabels[v] || v]; }));
  options(selects.severity, severities.map(function (s) { return [s, s]; }));
  options(selects.verdict, verdicts.map(function (v) { return [v, v]; }));
  Object.keys(selects).forEach(function (k) {
    selects[k].addEventListener("change", function () { filter[k] = selects[k].value; render(); });
  });
  function shown() {
    return all.filter(function (f) {
      var x = f.finding;
      return (filter.round === "" || String(x.round) === filter.round) &&
        (filter.vendor === "" || f.vendors.indexOf(filter.vendor) >= 0) &&
        (filter.severity === "" || x.severity === filter.severity) &&
        (filter.verdict === "" || x.verdict === filter.verdict);
    });
  }
  function selectedId() { return decodeURIComponent(location.hash.replace(/^#/, "")); }
  function diffView(diff, label) {
    if (!diff) return el("p", { className: "muted", text: "No diff." });
    var pre = el("pre", { className: "diff", "aria-label": label });
    diff.split("\\n").forEach(function (line) {
      var cls = line.indexOf("+++") === 0 || line.indexOf("---") === 0 ? "diff-file"
        : line.indexOf("@@") === 0 ? "diff-hunk"
        : line.charAt(0) === "+" ? "diff-add"
        : line.charAt(0) === "-" ? "diff-del" : "";
      pre.appendChild(el("span", { className: cls, text: line + "\\n" }));
    });
    return pre;
  }
  function fact(dl, term, value) {
    dl.appendChild(el("dt", { text: term }));
    dl.appendChild(typeof value === "string" ? el("dd", { text: value }) : el("dd", null, [value]));
  }
  function detail(item) {
    var f = item.finding;
    var card = el("article", { className: "card finding-detail", "aria-label": "Finding " + f.id });
    card.appendChild(el("h3", null, [f.id + " ", el("span", { className: "sev sev-" + f.severity, text: f.severity }), " " + f.title]));
    card.appendChild(el("p", { className: "mono small", text: item.location + " · " + f.category + " · round " + f.round + " · group " + (f.groupId || "none") }));
    var dl = el("dl", { className: "facts" });
    if (f.symbol) fact(dl, "Symbol", el("span", { className: "mono", text: f.symbol }));
    fact(dl, "Verdict", item.verdictText);
    fact(dl, "Raised by", [f.reportedBy].concat(f.alsoReportedBy || []).join(", "));
    fact(dl, "Introduced", f.introduced === null || f.introduced === undefined ? "Unknown: the run has no base to compare" : f.introduced ? "Yes, on this branch" : "No, it exists at the base");
    if (f.duplicateOf) fact(dl, "Duplicate of", el("span", { className: "mono", text: f.duplicateOf }));
    fact(dl, "Origin", el("span", null, [f.origin, item.sourceLink ? " " : null, item.sourceLink ? link(item.sourceLink, "source") : null]));
    fact(dl, "Fix commit", f.fixCommit ? link(item.commitLink, f.fixCommit.slice(0, 10), "mono") : "None");
    card.appendChild(dl);
    card.appendChild(el("h4", { text: "Failure case" }));
    card.appendChild(el("p", { text: f.failureCase }));
    card.appendChild(el("h4", { text: "Evidence" }));
    card.appendChild(f.evidence ? el("pre", { className: "evidence", text: f.evidence }) : el("p", { className: "muted", text: "None recorded." }));
    card.appendChild(el("h4", { text: "Diff" }));
    card.appendChild(diffView(item.diff, "Finding diff"));
    if (item.fixDiff) {
      card.appendChild(el("h4", { text: "Fix" }));
      card.appendChild(diffView(item.fixDiff, "Fix diff"));
    }
    card.appendChild(el("h4", { text: "Verdict trail" }));
    if (!f.history.length) card.appendChild(el("p", { className: "muted", text: "No changes yet." }));
    else {
      var ol = el("ol", { className: "trail" });
      f.history.forEach(function (h) {
        var who = h.actor.kind + (h.actor.vendor ? " " + h.actor.vendor : "") + (h.actor.role ? " (" + h.actor.role + ")" : "");
        ol.appendChild(el("li", null, [
          el("strong", { text: h.verdict }), " by " + who + (h.round ? ", round " + h.round : "") + " · ",
          el("time", { datetime: h.time, text: new Date(h.time).toLocaleString() }),
          h.evidence ? el("div", { className: "muted small", text: h.evidence }) : null
        ]));
      });
      card.appendChild(ol);
    }
    return card;
  }
  function render() {
    var list = shown();
    var id = selectedId();
    document.getElementById("count").textContent = list.length + " of " + all.length + " findings";
    var ul = document.getElementById("list");
    ul.textContent = "";
    list.forEach(function (item) {
      var f = item.finding;
      var b = el("button", { type: "button", className: f.id === id ? "finding-row selected" : "finding-row" }, [
        el("span", null, [el("span", { className: "sev sev-" + f.severity, text: f.severity })]),
        el("span", { className: "finding-title", text: f.title }),
        el("span", { className: "muted small", text: f.id + " · round " + f.round + " · " + item.verdictShort + " · " + item.vendors.map(function (v) { return data.vendorLabels[v] || v; }).join(", ") })
      ]);
      if (f.id === id) b.setAttribute("aria-current", "true");
      b.addEventListener("click", function () { location.hash = encodeURIComponent(f.id); });
      ul.appendChild(el("li", null, [b]));
    });
    var pane = document.getElementById("detail");
    pane.textContent = "";
    var picked = all.filter(function (f) { return f.finding.id === id; })[0];
    pane.appendChild(picked ? detail(picked) : el("p", { className: "muted", text: "Select a finding." }));
  }
  window.addEventListener("hashchange", render);
  render();
})();
`;

/**
 * One self-contained HTML file that lists, filters, and opens the findings
 * like the findings screen. It needs no server and loads nothing from the
 * network, so it can be shared as a single file.
 */
export function findingsHtml(e: FindingsExport): string {
  const { run } = e;
  const vendorLabels: Record<string, string> = { ...VENDOR_LABELS };
  const items = ordered(e.findings).map(({ finding: f, diff, fixDiff }) => ({
    finding: f,
    diff,
    fixDiff,
    location: location(f),
    verdictText: verdictText(f),
    verdictShort: `${f.verdict}${f.unverifiedReason ? ` (${NOT_VERIFIED_LABEL})` : ""}${f.fixHeldReason ? ` (${FIX_HELD_LABEL})` : ""}`,
    vendors: findingVendors(f),
    commitLink: f.fixCommit ? webLink(commitUrl(run.prUrl, f.fixCommit)) : null,
    sourceLink: webLink(f.externalRef?.url),
  }));
  const title = `Findings for ${repoName(run)}`;
  const facts = [
    `Run ${run.id} (${run.status})`,
    `${run.request.repoPath}, base ${run.request.base}${run.request.tip ? `, tip ${run.request.tip}` : ""}`,
    `Started ${run.createdAt}, exported ${e.exportedAt}`,
    counts(e.findings),
  ];
  const pr = webLink(run.prUrl);
  const causesHtml = run.rootCauses
    ? `<section class="card root-causes" aria-label="Root causes"><h3>Root causes</h3>${
        rootCauses(run).length === 0
          ? `<p class="muted">No root causes were found.</p>`
          : `<ol class="trail">${rootCauses(run)
              .map(
                (c) =>
                  `<li><strong>${escapeHtml(c.title)}</strong>${c.summary ? `<div>${escapeHtml(c.summary)}</div>` : ""}<div class="muted small">Findings: ${c.findingIds
                    .map(
                      (id) =>
                        `<a class="mono" href="#${encodeURIComponent(id)}">${escapeHtml(id)}</a>`,
                    )
                    .join(", ")}</div></li>`,
              )
              .join("")}</ol>`
      }${run.rootCauses.rationale ? `<p class="muted small">${escapeHtml(run.rootCauses.rationale)}</p>` : ""}</section>`
    : "";
  const field = (id: string, label: string) =>
    `<label class="field" for="${id}"><span class="field-label">${label}</span><select id="${id}"></select></label>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title>
<style>${themeCss}${REPORT_CSS}</style>
</head>
<body>
<div class="screen">
<h2>${escapeHtml(title)}</h2>
<div class="muted small run-facts">${facts.map((f) => `<div>${escapeHtml(f)}</div>`).join("")}${pr ? `<div><a href="${escapeHtml(pr)}" target="_blank" rel="noreferrer">${escapeHtml(pr)}</a></div>` : ""}</div>
${causesHtml}
<div class="filter-row">${field("f-round", "Round")}${field("f-vendor", "Vendor")}${field("f-severity", "Severity")}${field("f-verdict", "Verdict")}</div>
<div class="split">
<div class="list-pane"><p class="muted small" id="count"></p><ul class="finding-list" id="list"></ul></div>
<div class="detail-pane" id="detail"></div>
</div>
</div>
<noscript><p>This report needs JavaScript to list the findings. The data is in the findings-data element of the page source.</p></noscript>
<script type="application/json" id="findings-data">${scriptJson({ vendorLabels, findings: items })}</script>
<script>${REPORT_SCRIPT}</script>
</body>
</html>
`;
}

/** Builds the export in one format. */
export function renderExport(format: ExportFormat, e: FindingsExport): string {
  return format === "json"
    ? findingsJson(e)
    : format === "markdown"
      ? findingsMarkdown(e)
      : findingsHtml(e);
}
