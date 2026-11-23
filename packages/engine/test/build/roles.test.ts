import { describe, expect, it } from "vitest";
import { RoleError, parseRole } from "../../src/build/roles/index.js";

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
