// Account-owned instruction sources; includes replace host configuration links.
import fs from "node:fs";
import path from "node:path";
import type { Platform } from "@aio/contracts";

function writeMissing(file: string, text: string): void {
  try {
    fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/** Fill missing layers without replacing instructions the owner has edited. */
export function ensureAccountInstructions(dir: string, vendor: Platform): void {
  const global = path.resolve(dir, "../../AGENTS.md");
  writeMissing(global, "<!-- Global instructions for every account. -->\n");
  if (vendor === "claude") {
    writeMissing(path.join(dir, "AGENTS.md"), "<!-- Account instructions. -->\n");
    writeMissing(
      path.join(dir, "CLAUDE.md"),
      "<!-- Includes: global instructions, then account instructions. -->\n@../../AGENTS.md\n@AGENTS.md\n",
    );
  } else {
    writeMissing(
      path.join(dir, "instructions.md"),
      "@../../AGENTS.md\n\n<!-- Account instructions. -->\n",
    );
  }
}
