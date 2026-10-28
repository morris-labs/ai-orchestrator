import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { barChunkColor, blend, cssVariables, derived, palette } from "../src/core";

describe("theme", () => {
  it("keeps theme.css in step with the tokens", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/theme/theme.css"), "utf8");
    for (const [name, value] of Object.entries(cssVariables())) {
      expect(css).toContain(`${name}: ${value};`);
    }
  });
  it("matches the Qt palette", () => {
    expect(palette.accent).toBe("#d97757");
    expect(derived.selectionBg).toBe(blend(palette.accent, palette.baseBg, 0.22));
  });
  it("colors bars green, then toward red", () => {
    expect(barChunkColor(0.3)).toBe("#2da050");
    expect(barChunkColor(1)).toBe("#c85032");
    expect(barChunkColor(0.8)).not.toBe("#2da050");
  });
});
