// The server installs the skills it ships, such as `aio-build`, into each
// Claude account at start, and touches nothing else in the account.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_SOCKET_ROUTES, BuildPlanSchema } from "@aio/contracts";
import { PACKAGED_SKILLS_DIR } from "../../src/accounts/packaged-skills.js";
import { configureTestAccounts } from "../account-fixture.js";
import { makeHarness } from "../boxes/harness.js";

const SKILL = path.join(PACKAGED_SKILLS_DIR, "aio-build", "SKILL.md");

/** Every file under `dir`, relative to it, with its bytes; symbolic links as `-> TARGET`. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) walk(full);
      else out[rel] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

function claudeDir(h: ReturnType<typeof makeHarness>): string {
  const account = h.core.accounts.list().find((a) => a.account.vendor === "claude");
  if (!account) throw new Error("no Claude account");
  return account.dir;
}

describe("packaged skills", () => {
  it("installs the aio-build skill into a Claude account at server start and touches nothing else", async () => {
    const h = makeHarness();
    const dir = claudeDir(h);
    fs.rmSync(path.join(dir, "skills"), { recursive: true, force: true });
    const before = snapshot(dir);

    await h.core.start({ importLegacy: false, pollMs: 0, watch: false });

    const after = snapshot(dir);
    const added = Object.keys(after).filter((k) => !(k in before));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((k) => k.startsWith(`skills${path.sep}aio-build${path.sep}`))).toBe(true);
    for (const key of Object.keys(before)) expect(after[key]).toBe(before[key]);
    expect(fs.readFileSync(path.join(dir, "skills/aio-build/SKILL.md"), "utf8")).toBe(
      fs.readFileSync(SKILL, "utf8"),
    );
    h.core.close();
  });

  it("replaces an outdated copy and keeps the account's other skills", async () => {
    const h = makeHarness();
    const dir = claudeDir(h);
    fs.mkdirSync(path.join(dir, "skills/aio-build"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills/own"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills/aio-build/SKILL.md"), "an older version\n");
    fs.writeFileSync(path.join(dir, "skills/own/SKILL.md"), "the owner's skill\n");

    await h.core.start({ importLegacy: false, pollMs: 0, watch: false });

    expect(fs.readFileSync(path.join(dir, "skills/aio-build/SKILL.md"), "utf8")).toBe(
      fs.readFileSync(SKILL, "utf8"),
    );
    expect(fs.readFileSync(path.join(dir, "skills/own/SKILL.md"), "utf8")).toBe(
      "the owner's skill\n",
    );
    h.core.close();
  });

  it("installs only into Claude accounts", async () => {
    const h = makeHarness();
    await h.core.start({ importLegacy: false, pollMs: 0, watch: false });
    for (const account of h.core.accounts.list().filter((a) => a.account.vendor !== "claude")) {
      expect(fs.existsSync(path.join(account.dir, "skills/aio-build"))).toBe(false);
    }
    h.core.close();
  });

  it("leaves a skills folder that links outside the account alone and says so", async () => {
    const logs: string[] = [];
    const h = makeHarness({ log: (m) => logs.push(m) });
    const dir = claudeDir(h);
    const outside = h.dir("elsewhere", "skills");
    fs.rmSync(path.join(dir, "skills"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(dir, "skills"));

    await h.core.start({ importLegacy: false, pollMs: 0, watch: false });

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(logs.join("\n")).toMatch(/aio-build.*symbolic link/);
    h.core.close();
  });

  it("installs the skill when a box prepares an account that the start didn't see", () => {
    const h = makeHarness({ accounts: false });
    configureTestAccounts(h.core);
    const { dir } = h.core.accounts.prepareAccount("claude");
    expect(fs.readFileSync(path.join(dir, "skills/aio-build/SKILL.md"), "utf8")).toBe(
      fs.readFileSync(SKILL, "utf8"),
    );
    h.core.close();
  });
});

describe("the aio-build skill", () => {
  it("ships a small build plan template that the engine's freeze accepts", () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(PACKAGED_SKILLS_DIR, "aio-build", "small-plan.json"), "utf8"),
    ) as unknown;
    const plan = BuildPlanSchema.parse(template);
    expect(plan.size).toBe("small");
    expect(plan.tasks).toHaveLength(1);
    expect(plan.push).toBeNull();
    expect(plan.flow).toBeNull();
    expect(plan.recommendation?.flow).toBe("single_session");
  });

  it("names only requests that the aio-build command has", () => {
    const dir = path.join(PACKAGED_SKILLS_DIR, "aio-build");
    const text = ["SKILL.md", "triage.md"]
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    const named = new Set([...text.matchAll(/aio-build ([a-z][a-z-]*)/g)].map((m) => m[1]!));
    const known = new Set([...Object.keys(BUILD_SOCKET_ROUTES), "help"]);
    expect([...named].filter((kind) => !known.has(kind))).toEqual([]);
    for (const kind of ["plan", "meet", "freeze", "start", "inbox", "resolve"])
      expect(named).toContain(kind);
  });
});
