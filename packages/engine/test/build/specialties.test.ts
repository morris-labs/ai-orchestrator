import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SpecialtyError,
  SpecialtyPlanError,
  UnknownSpecialtyError,
  accountSkillDirs,
  checkPlanSpecialties,
  findSpecialty,
  listSpecialties,
  loadSpecialties,
  type SpecialtySources,
} from "../../src/build/specialties/index.js";
import { tempDir } from "../tmp.js";

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A repository and an account skills folder, with the files that `files` names. */
function sources(files: Record<string, string> = {}): SpecialtySources & { skills: string } {
  const root = tempDir("aio-specialties-");
  const repoRoot = join(root, "repo");
  const skills = join(root, "account", "skills");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(skills, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    write(path.startsWith("skills/") ? join(skills, path.slice(7)) : join(repoRoot, path), text);
  }
  return { repoRoot, skillDirs: [skills], skills };
}

const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Guidance for ${name}.\n---\n\n${body}\n`;

describe("findSpecialty", () => {
  it("reads an account skill's text without its front matter", async () => {
    const s = sources({ "skills/go-dev/SKILL.md": skill("go-dev", "Wrap errors with %w.") });

    const pack = await findSpecialty("go-dev", s);

    expect(pack).toEqual({
      name: "go-dev",
      source: "account",
      path: join(s.skills, "go-dev", "SKILL.md"),
      dir: join(s.skills, "go-dev"),
      text: "Wrap errors with %w.",
    });
  });

  it("lets a repository specialty override an account skill of the same name", async () => {
    const s = sources({
      "skills/node-dev/SKILL.md": skill("node-dev", "Account guidance."),
      ".aio/team/specialties/node-dev.md": "Use the repository's own logger.",
    });

    const pack = await findSpecialty("node-dev", s);

    expect(pack?.source).toBe("repository");
    expect(pack?.text).toBe("Use the repository's own logger.");
  });

  it("reads a repository specialty kept as a skill folder", async () => {
    const s = sources({
      ".aio/team/specialties/sql/SKILL.md": skill("sql", "Name every column."),
    });

    expect((await findSpecialty("sql", s))?.text).toBe("Name every column.");
  });

  it("takes the first skills folder that has the skill", async () => {
    const s = sources({ "skills/go-dev/SKILL.md": skill("go-dev", "First.") });
    const later = tempDir("aio-specialties-later-");
    write(join(later, "go-dev", "SKILL.md"), skill("go-dev", "Second."));

    const pack = await findSpecialty("go-dev", { ...s, skillDirs: [s.skills, later] });

    expect(pack?.text).toBe("First.");
  });

  it("returns undefined for a name that nothing defines", async () => {
    expect(await findSpecialty("rust-dev", sources())).toBeUndefined();
  });

  it("refuses a pack with no guidance and names the file", async () => {
    const s = sources({ ".aio/team/specialties/empty.md": "---\nname: empty\n---\n" });

    await expect(findSpecialty("empty", s)).rejects.toThrow(SpecialtyError);
    await expect(findSpecialty("empty", s)).rejects.toThrow(/empty\.md/);
  });
});

describe("loadSpecialties", () => {
  it("loads packs in the order the task names them", async () => {
    const s = sources({
      "skills/go-dev/SKILL.md": skill("go-dev", "Go."),
      ".aio/team/specialties/sql.md": "SQL.",
    });

    const packs = await loadSpecialties(["sql", "go-dev"], s);

    expect(packs.map((p) => p.name)).toEqual(["sql", "go-dev"]);
  });

  it("throws for an unknown specialty and names it", async () => {
    const s = sources({ "skills/go-dev/SKILL.md": skill("go-dev", "Go.") });

    await expect(loadSpecialties(["go-dev", "cobol-dev"], s)).rejects.toThrow(
      UnknownSpecialtyError,
    );
    await expect(loadSpecialties(["cobol-dev"], s)).rejects.toThrow(/cobol-dev/);
  });
});

describe("checkPlanSpecialties", () => {
  it("passes a plan whose specialties all exist", async () => {
    const s = sources({ "skills/go-dev/SKILL.md": skill("go-dev", "Go.") });

    await expect(
      checkPlanSpecialties([{ id: "T1", specialties: ["go-dev"] }, { id: "T2" }], s),
    ).resolves.toBeUndefined();
  });

  it("fails a plan with an unknown specialty and names it and its task", async () => {
    const s = sources({ "skills/go-dev/SKILL.md": skill("go-dev", "Go.") });
    const plan = [
      { id: "T1", specialties: ["go-dev", "cobol-dev"] },
      { id: "T2", specialties: ["fortran-dev"] },
    ];

    const error = await checkPlanSpecialties(plan, s).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SpecialtyPlanError);
    expect((error as SpecialtyPlanError).unknown).toEqual([
      { taskId: "T1", specialty: "cobol-dev" },
      { taskId: "T2", specialty: "fortran-dev" },
    ]);
    expect((error as Error).message).toMatch(/T1.*cobol-dev/);
    expect((error as Error).message).toMatch(/T2.*fortran-dev/);
  });

  it("fails a plan with a specialty name that isn't valid", async () => {
    await expect(
      checkPlanSpecialties([{ id: "T1", specialties: ["../etc"] }], sources()),
    ).rejects.toThrow(/T1.*\.\.\/etc/);
  });
});

describe("listSpecialties", () => {
  it("lists every specialty once, sorted, with its winning source", async () => {
    const s = sources({
      "skills/node-dev/SKILL.md": skill("node-dev", "Account."),
      "skills/go-dev/SKILL.md": skill("go-dev", "Go."),
      ".aio/team/specialties/node-dev.md": "Repository.",
      ".aio/team/specialties/sql/SKILL.md": "SQL.",
    });

    expect(await listSpecialties(s)).toEqual([
      { name: "go-dev", source: "account" },
      { name: "node-dev", source: "repository" },
      { name: "sql", source: "repository" },
    ]);
  });
});

describe("accountSkillDirs", () => {
  it("lists each vendor's account skills folder, Claude first", () => {
    expect(
      accountSkillDirs({ codex: "/data/accounts/codex/work", claude: "/data/accounts/claude/me" }),
    ).toEqual(["/data/accounts/claude/me/skills", "/data/accounts/codex/work/skills"]);
  });
});
