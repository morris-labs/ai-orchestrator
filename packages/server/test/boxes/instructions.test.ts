import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeHarness } from "./harness.js";
import { accountDirFor } from "../../src/records/env.js";

for (const vendor of ["codex", "copilot"] as const) {
  describe(`${vendor} box instruction preparation`, () => {
    it("rebuilds both instruction layers at each primary box start", async () => {
      const h = makeHarness();
      const dir = accountDirFor(h.env, vendor, "fixture");
      const global = path.resolve(dir, "../../AGENTS.md");
      const source = path.join(dir, "instructions.md");
      fs.writeFileSync(global, "Global account rules\n");
      fs.writeFileSync(source, "@../../AGENTS.md\nVendor account rules\n@shared.md\n");
      fs.writeFileSync(path.join(dir, "shared.md"), "Shared account rules\n");
      const box = await h.core.boxes.create({
        targetDir: h.dir("work"),
        layout: "root",
        platform: vendor,
      });
      const generated = path.join(
        dir,
        vendor === "codex" ? "AGENTS.md" : "copilot-instructions.md",
      );
      expect(fs.readFileSync(generated, "utf8")).toMatch(
        /Global account rules[\s\S]*Vendor account rules[\s\S]*Shared account rules[\s\S]*Generated/,
      );
      await h.core.boxes.stop(box.id);
      fs.writeFileSync(global, "Edited global rules\n");
      await h.core.boxes.start(box.id);
      expect(fs.readFileSync(generated, "utf8")).toContain("Edited global rules");
      expect(fs.readFileSync(source, "utf8")).toBe(
        "@../../AGENTS.md\nVendor account rules\n@shared.md\n",
      );
    });
    it("builds side-session instructions, reports missing includes, and bounds loops and depth", async () => {
      const problems: string[] = [];
      const h = makeHarness({ log: (message) => problems.push(message) });
      const dir = accountDirFor(h.env, vendor, "fixture");
      fs.writeFileSync(path.resolve(dir, "../../AGENTS.md"), "Global rules\n");
      fs.writeFileSync(
        path.join(dir, "instructions.md"),
        "@../../AGENTS.md\nLocal rules\n@missing.md\n@one.md\n@loop.md\n",
      );
      fs.writeFileSync(path.join(dir, "one.md"), "Depth one\n@two.md\n");
      fs.writeFileSync(path.join(dir, "two.md"), "Depth two\n@three.md\n");
      fs.writeFileSync(path.join(dir, "three.md"), "Depth three\n@four.md\n");
      fs.writeFileSync(path.join(dir, "four.md"), "Not expanded\n");
      fs.writeFileSync(path.join(dir, "loop.md"), "Loop rules\n@loop.md\n");
      const box = await h.core.boxes.create({ targetDir: h.dir("work"), layout: "root" });
      await h.core.boxes.startSideSession(box.id, vendor);
      const generated = fs.readFileSync(
        path.join(dir, vendor === "codex" ? "AGENTS.md" : "copilot-instructions.md"),
        "utf8",
      );
      expect(generated).toContain("Depth three");
      expect(generated).not.toContain("Not expanded");
      expect(generated).not.toContain("@missing.md");
      expect(problems.join("\n")).toMatch(/missing.md/);
      expect(problems.join("\n")).toMatch(/loop skipped/);
      expect(problems.join("\n")).toMatch(/depth limit of 3/);
    });
  });
}

it("prepares default vendor instructions when ensuring a review-only project container", async () => {
  const h = makeHarness();
  const project = h.core.projects.create({ root: h.dir("review") });
  for (const vendor of ["codex", "copilot"] as const) {
    const dir = accountDirFor(h.env, vendor, "fixture");
    fs.writeFileSync(path.join(dir, "instructions.md"), "@../../AGENTS.md\nReview account rules\n");
  }
  await h.core.projects.ensureContainer(project.id);
  for (const vendor of ["codex", "copilot"] as const) {
    const dir = accountDirFor(h.env, vendor, "fixture");
    const output = path.join(dir, vendor === "codex" ? "AGENTS.md" : "copilot-instructions.md");
    expect(fs.readFileSync(output, "utf8")).toContain("Review account rules");
    fs.writeFileSync(path.join(dir, "instructions.md"), "Edited review account rules\n");
  }
  await h.core.projects.ensureContainer(project.id);
  for (const vendor of ["codex", "copilot"] as const) {
    const dir = accountDirFor(h.env, vendor, "fixture");
    expect(
      fs.readFileSync(
        path.join(dir, vendor === "codex" ? "AGENTS.md" : "copilot-instructions.md"),
        "utf8",
      ),
    ).toContain("Edited review account rules");
  }
});
