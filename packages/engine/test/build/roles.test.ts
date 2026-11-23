import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RoleError,
  UnknownRoleError,
  loadRole,
  loadRoles,
  parseRole,
  rolePrompt,
  writablePaths,
  type RoleTask,
} from "../../src/build/roles/index.js";
import { tempDir } from "../tmp.js";

/** A valid role definition, with `extra` front matter lines and without the `omit` field. */
function roleText(options: { extra?: string; omit?: string } = {}): string {
  const fields: Record<string, string> = {
    name: "name: reviewer-of-notes",
    title: "title: Reviewer of notes",
    purpose: "purpose: Reads the notes and reports gaps.",
    activation: "activation:\n  group: bench\n  when: The project keeps notes.",
    inputs: "inputs:\n  - name: notes\n    description: The notes to read.",
    outputs:
      "outputs:\n  - name: report\n    description: The gaps found.\n    schema:\n      type: object\n      properties:\n        gaps: { type: array, items: { type: string } }\n      required: [gaps]",
    permission: "permission:\n  access: read-only",
    placement: "placement:\n  vendor: codex\n  tier: medium\n  effort: low",
    turnTimeoutMinutes: "turnTimeoutMinutes: 20",
    rules: "rules:\n  - Report only gaps you can point to.",
  };
  const lines = Object.entries(fields)
    .filter(([key]) => key !== options.omit)
    .map(([, line]) => line);
  if (options.extra) lines.push(options.extra);
  return `---\n${lines.join("\n")}\n---\n\nRead the notes.\n`;
}

describe("parseRole", () => {
  it("parses a valid definition and keeps the body as instructions", () => {
    const role = parseRole(roleText(), "reviewer-of-notes.md");
    expect(role.name).toBe("reviewer-of-notes");
    expect(role.permission).toEqual({ access: "read-only" });
    expect(role.placement).toEqual({ vendor: "codex", tier: "medium", effort: "low" });
    expect(role.instructions).toBe("Read the notes.");
  });

  it("rejects an unknown field and names it", () => {
    expect(() => parseRole(roleText({ extra: "colour: blue" }), "x.md")).toThrow(RoleError);
    expect(() => parseRole(roleText({ extra: "colour: blue" }), "x.md")).toThrow(/colour/);
  });

  it("rejects an unknown nested field and names its path", () => {
    const text = roleText().replace("  effort: low", "  effort: low\n  speed: fast");
    expect(() => parseRole(text, "x.md")).toThrow(/placement.*speed/);
  });

  it.each(["purpose", "activation", "permission", "placement", "turnTimeoutMinutes", "rules"])(
    "rejects a definition without %s and names it",
    (field) => {
      expect(() => parseRole(roleText({ omit: field }), "x.md")).toThrow(
        new RegExp(`x\\.md.*${field}`),
      );
    },
  );

  it("rejects writable access without path globs", () => {
    const text = roleText().replace("access: read-only", "access: write\n  paths: []");
    expect(() => parseRole(text, "x.md")).toThrow(/permission\.paths/);
  });

  it("rejects a file without front matter", () => {
    expect(() => parseRole("Just text.\n", "x.md")).toThrow(/front matter/);
  });
});

describe("loadRoles", () => {
  function writeRole(dir: string, name: string, text: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), text);
  }

  function setup(): { library: string; repo: string } {
    const library = tempDir("aio-roles-lib-");
    const repo = tempDir("aio-roles-repo-");
    writeRole(library, "reviewer-of-notes", roleText());
    return { library, repo };
  }

  it("loads the shipped library when the repository has no team directory", async () => {
    const { library, repo } = setup();
    const roles = await loadRoles(repo, { libraryDir: library });
    expect([...roles.keys()]).toEqual(["reviewer-of-notes"]);
    expect(roles.get("reviewer-of-notes")?.source).toBe("library");
  });

  it("replaces a shipped role with the repository role of the same name", async () => {
    const { library, repo } = setup();
    const override = roleText().replace("Read the notes.", "Read the notes twice.");
    writeRole(join(repo, ".aio", "team"), "reviewer-of-notes", override);
    const role = await loadRole("reviewer-of-notes", repo, { libraryDir: library });
    expect(role.source).toBe("repository");
    expect(role.instructions).toBe("Read the notes twice.");
    expect(role.path).toBe(join(repo, ".aio", "team", "reviewer-of-notes.md"));
  });

  it("adds a repository role that the library doesn't ship", async () => {
    const { library, repo } = setup();
    const added = roleText().replaceAll("reviewer-of-notes", "release-checker");
    writeRole(join(repo, ".aio", "team"), "release-checker", added);
    const roles = await loadRoles(repo, { libraryDir: library });
    expect([...roles.keys()].sort()).toEqual(["release-checker", "reviewer-of-notes"]);
  });

  it("ignores the specialties directory and files that aren't Markdown", async () => {
    const { library, repo } = setup();
    const team = join(repo, ".aio", "team");
    writeRole(join(team, "specialties"), "go", "Go guidance.\n");
    mkdirSync(team, { recursive: true });
    writeFileSync(join(team, "notes.txt"), "not a role");
    const roles = await loadRoles(repo, { libraryDir: library });
    expect([...roles.keys()]).toEqual(["reviewer-of-notes"]);
  });

  it("rejects a role whose name differs from its file name", async () => {
    const { library, repo } = setup();
    writeRole(join(repo, ".aio", "team"), "other-name", roleText());
    await expect(loadRoles(repo, { libraryDir: library })).rejects.toThrow(/other-name\.md.*name/);
  });

  it("rejects an invalid repository role instead of falling back to the library", async () => {
    const { library, repo } = setup();
    writeRole(join(repo, ".aio", "team"), "reviewer-of-notes", roleText({ omit: "rules" }));
    await expect(loadRole("reviewer-of-notes", repo, { libraryDir: library })).rejects.toThrow(
      RoleError,
    );
  });

  it("names the role when it doesn't exist", async () => {
    const { library, repo } = setup();
    await expect(loadRole("astronaut", repo, { libraryDir: library })).rejects.toThrow(
      UnknownRoleError,
    );
  });
});

describe("the Developer role", () => {
  const task: RoleTask = {
    id: "T3",
    title: "Add the export button",
    description: "Add a button that exports the report as CSV.",
    repoPath: "/work/repo",
    branch: "build/T3",
    ownedFiles: ["src/export.ts", "test/export.test.ts"],
    contracts: ["src/contracts/report.ts"],
    criteria: [{ id: "AC2", text: "The export holds one row per report line." }],
    tests: ["test/export.test.ts"],
  };

  it("ships in the library with its default placement", async () => {
    const repo = tempDir("aio-roles-repo-");
    const role = await loadRole("developer", repo);
    expect(role.source).toBe("library");
    expect(role.title).toBe("Developer");
    expect(role.activation.group).toBe("core");
    expect(role.placement).toEqual({ vendor: "claude", tier: "large", effort: "medium" });
    expect(role.permission).toEqual({ access: "write", paths: ["{owned}"] });
  });

  it("produces the prompt for one task", async () => {
    const role = await loadRole("developer", tempDir("aio-roles-repo-"));
    const prompt = rolePrompt(role, task);
    expect(prompt).toContain("You are the Developer");
    expect(prompt).toContain(role.instructions);
    for (const rule of role.rules) expect(prompt).toContain(rule);
    expect(prompt).toContain("T3: Add the export button");
    expect(prompt).toContain("/work/repo");
    expect(prompt).toContain("build/T3");
    expect(prompt).toContain("- src/export.ts");
    expect(prompt).toContain("- src/contracts/report.ts");
    expect(prompt).toContain("- AC2: The export holds one row per report line.");
    expect(prompt).toContain("- test/export.test.ts");
    expect(prompt).toContain("Answer with exactly one JSON object");
    expect(prompt).toContain('"criteria"');
  });

  it("limits writes to the task's owned files", async () => {
    const role = await loadRole("developer", tempDir("aio-roles-repo-"));
    expect(writablePaths(role, task)).toEqual(["src/export.ts", "test/export.test.ts"]);
    expect(rolePrompt(role, task)).toContain(
      "Change only these files: src/export.ts, test/export.test.ts.",
    );
  });

  it("tells a read-only role to change no file and leaves out empty sections", () => {
    const role = parseRole(roleText(), "reviewer-of-notes.md");
    const prompt = rolePrompt(role, { ...task, contracts: [], tests: [] });
    expect(writablePaths(role, task)).toEqual([]);
    expect(prompt).toContain("Don't change, create, or delete any file.");
    expect(prompt).not.toContain("## Contracts");
    expect(prompt).not.toContain("## Tests that must pass");
  });
});
