import { DEFAULT_POLICY, defaultConfig } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import {
  canWaive,
  filterFindings,
  findingVendors,
  NO_FILTER,
} from "../src/screens/findingsModel.js";
import { DEFAULT_FORM, buildRunRequest, formFromBox } from "../src/screens/launcherModel.js";
import { commaList, lines, parsePolicyYaml, policyToYaml } from "../src/screens/policyModel.js";
import {
  draftFrom,
  settingsPatch,
  switchCeilingKind,
  vendorDefaultsPatch,
} from "../src/screens/settingsModel.js";
import { deepLink, href, parseHash } from "../src/state/router.js";
import { demoBox, demoFindings } from "./helpers/data.js";

describe("buildRunRequest", () => {
  const ok = { ...DEFAULT_FORM, projectId: "p", repoPath: "/r" };
  it("applies the design defaults", () => {
    const r = buildRunRequest(ok);
    expect(r).toMatchObject({
      ok: true,
      request: {
        base: "origin/main",
        mergeBase: true,
        exactBase: false,
        profile: "offload",
        roundCap: 25,
        crossVendor: true,
      },
    });
  });

  it.each([
    [{ projectId: "" }, /container/],
    [{ repoPath: "" }, /repository/],
    [{ base: " " }, /base/],
    [{ roundCap: "0" }, /round cap/],
    [{ pipeline: "post-push" as const, prNumber: "" }, /pull request number/],
    [{ base: "pr", tip: "" }, /tip branch/],
  ])("refuses %o", (patch, message) => {
    const r = buildRunRequest({ ...ok, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(message);
  });

  it("folds the exact base into mergeBase false and keeps the PR number", () => {
    const r = buildRunRequest({
      ...ok,
      baseMode: "exact",
      pipeline: "post-push",
      prNumber: "42",
      tip: "x",
    });
    expect(r).toMatchObject({
      ok: true,
      request: { mergeBase: false, exactBase: true, prNumber: 42, tip: "x" },
    });
  });

  it("prefills from a box", () => {
    const f = formFromBox(DEFAULT_FORM, demoBox());
    expect(f).toMatchObject({
      projectId: "example-app-1a2b3c4d",
      boxId: "aio-agent-emails_not_sending",
      repoPath: "/home/user/src/example-app/.worktrees/Emails_not_sending",
      tip: "claude/Emails_not_sending",
    });
  });

  it("prefills the container path of a Windows box", () => {
    const box = { ...demoBox(), worktree: "C:/Users/dev/app/.worktrees/fix" };
    expect(formFromBox(DEFAULT_FORM, box).repoPath).toBe(
      "/mnt/host/c/Users/dev/app/.worktrees/fix",
    );
    expect(formFromBox(DEFAULT_FORM, box, "/mnt/host/c/x").repoPath).toBe("/mnt/host/c/x");
  });
});

describe("filterFindings", () => {
  const all = demoFindings();
  it.each([
    [NO_FILTER, ["F-0001", "F-0007", "F-0002", "F-0003", "F-0008", "F-0004"]],
    [{ ...NO_FILTER, round: 2 }, ["F-0007", "F-0008"]],
    [{ ...NO_FILTER, vendor: "copilot" as const }, ["F-0001", "F-0002", "F-0008"]],
    [{ ...NO_FILTER, severity: "P1" as const }, ["F-0001", "F-0007"]],
    [{ ...NO_FILTER, verdict: "fixed" as const }, ["F-0001", "F-0003"]],
  ])("%o", (filter, want) => {
    expect(filterFindings(all, filter).map((f) => f.id)).toEqual(want);
  });

  it("lists every vendor that raised a finding", () => {
    expect(findingVendors(all.find((f) => f.id === "F-0001")!)).toEqual(["codex", "copilot"]);
  });

  it.each([
    ["pending", true],
    ["confirmed", true],
    ["pre-existing", true],
    ["fixed", false],
    ["disproved", false],
    ["waived", false],
  ] as const)("canWaive(%s)", (verdict, want) => {
    expect(canWaive({ ...all[0]!, verdict })).toBe(want);
  });
});

describe("policy YAML", () => {
  it("round-trips the default policy", () => {
    const r = parsePolicyYaml(policyToYaml(DEFAULT_POLICY));
    expect(r).toEqual({ ok: true, policy: DEFAULT_POLICY });
  });

  it.each([
    ["version: 1\nriskPaths: [src/auth/**]\n", true, ""],
    ["", false, /version/],
    ["version: 2\n", false, /version/],
    ["version: 1\nrisk_paths: []\n", false, /Unrecognized key/],
    ["version: 1\n  bad: [", false, /YAML/],
  ])("%j", (text, ok, message) => {
    const r = parsePolicyYaml(text);
    expect(r.ok).toBe(ok);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(message);
  });

  it("splits form fields", () => {
    expect(lines(" a \n\n b\n")).toEqual(["a", "b"]);
    expect(commaList("a, b ,")).toEqual(["a", "b"]);
    expect(commaList(" ")).toBeUndefined();
  });
});

describe("settingsPatch", () => {
  const s = defaultConfig();
  it("returns null when nothing changed", () => {
    expect(settingsPatch(s, draftFrom(s))).toBeNull();
  });

  it("sends only the changed ceiling and toggle", () => {
    const d = draftFrom(s);
    d.ceilings.codex = { kind: "utilization", window: "5h", max: 0.5 };
    d.notifications.roundSummary = false;
    expect(settingsPatch(s, d)).toEqual({
      ceilings: { codex: { kind: "utilization", window: "5h", max: 0.5 } },
      notifications: { roundSummary: false },
    });
  });

  it("sends changed vendor defaults and clears an emptied one with null", () => {
    const set = {
      ...s,
      vendorDefaults: {
        claude: { model: "claude-opus-5-5", effort: "high" as const },
        codex: {},
        copilot: { model: "auto" },
      },
    };
    const d = draftFrom(set);
    expect(d.vendorDefaults).toEqual({
      claudeModel: "claude-opus-5-5",
      claudeEffort: "high",
      codexModel: "",
      copilotModel: "auto",
    });
    d.vendorDefaults.claudeEffort = "";
    d.vendorDefaults.codexModel = " gpt-6-codex ";
    d.vendorDefaults.copilotModel = "";
    expect(vendorDefaultsPatch(set, d.vendorDefaults)).toEqual({
      claude: { effort: null },
      codex: { model: "gpt-6-codex" },
    });
    d.vendorDefaults.copilotModel = "gpt-6";
    expect(settingsPatch(set, d)?.vendorDefaults?.copilot).toEqual({ model: "gpt-6" });
  });

  it("switches a ceiling kind with defaults", () => {
    expect(switchCeilingKind(s.ceilings.claude, "spend")).toEqual({
      kind: "spend",
      period: "month",
      maxUsd: 70,
    });
    expect(switchCeilingKind(s.ceilings.claude, "utilization")).toBe(s.ceilings.claude);
  });
});

describe("router", () => {
  it.each([
    ["", "launch", {}],
    ["#/runs", "runs", {}],
    ["#/runs/ABC", "run", { runId: "ABC" }],
    ["#/findings?run=R&finding=F-0001", "findings", {}],
    ["#/nowhere", "launch", {}],
  ])("parseHash(%j)", (hash, name, params) => {
    const r = parseHash(hash);
    expect(r.name).toBe(name);
    expect(r.params).toEqual(params);
  });

  it("builds hrefs and reads the deep link", () => {
    expect(href("/findings", { run: "R", finding: undefined })).toBe("#/findings?run=R");
    expect(parseHash("#/findings?run=R&finding=F-0001").query.get("finding")).toBe("F-0001");
    expect(deepLink("?project=p&box=b")).toEqual({ project: "p", box: "b", machine: null });
    expect(deepLink("")).toEqual({ project: null, box: null, machine: null });
    expect(deepLink("?box=b&machine=m1")).toEqual({ project: null, box: "b", machine: "m1" });
  });

  it("keeps a malformed percent-escape in the hash instead of throwing", () => {
    expect(() => parseHash("#/runs/%E0%A4")).not.toThrow();
    expect(parseHash("#/runs/%E0%A4").params.runId).toBe("%E0%A4");
    expect(parseHash("#/runs/a%20b").params.runId).toBe("a b");
  });
});
