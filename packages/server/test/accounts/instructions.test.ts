import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeHarness } from "../boxes/harness.js";

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe("account instruction layers", () => {
  it("creates global and Claude account instructions once with global include first", () => {
    const h = makeHarness({ accounts: false });
    const first = h.core.accounts.create({ vendor: "claude", name: "personal" });
    const global = path.resolve(first.dir, "../../AGENTS.md");
    const local = path.join(first.dir, "AGENTS.md");
    const claude = path.join(first.dir, "CLAUDE.md");
    expect(fs.readFileSync(global, "utf8")).toMatch(/^<!--[^\n]+-->\n$/);
    expect(fs.readFileSync(local, "utf8")).toMatch(/^<!--[^\n]+-->\n$/);
    expect(fs.readFileSync(claude, "utf8")).toContain("@../../AGENTS.md\n@AGENTS.md");
    write(global, "Global working rules\n");
    write(local, "Account working rules\n");
    write(claude, "@../../AGENTS.md\n@AGENTS.md\n@extra.md\n");
    const second = h.core.accounts.create({ vendor: "claude", name: "work" });
    expect(path.resolve(second.dir, "../../AGENTS.md")).toBe(global);
    h.core.accounts.relink();
    expect(fs.readFileSync(global, "utf8")).toBe("Global working rules\n");
    expect(fs.readFileSync(local, "utf8")).toBe("Account working rules\n");
    expect(fs.readFileSync(claude, "utf8")).toBe("@../../AGENTS.md\n@AGENTS.md\n@extra.md\n");
    h.core.close();
  });
});
