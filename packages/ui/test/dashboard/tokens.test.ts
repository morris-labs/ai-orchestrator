import { describe, expect, it } from "vitest";
import { dashboardTokens, themeCss, vendorColor } from "../../src/dashboard";
import { cssVariables, palette } from "../../src/theme/tokens";

describe("dashboard tokens", () => {
  it("carries every shared theme variable", () => {
    for (const [name, value] of Object.entries(cssVariables())) {
      expect(themeCss).toContain(`${name}: ${value};`);
    }
  });
  it("aliases surfaces and status to the shared palette", () => {
    expect(dashboardTokens["--ab-surface"]).toBe(palette.panelBg);
    expect(dashboardTokens["--ab-critical"]).toBe(palette.stopped);
    expect(themeCss).toContain(`--ab-page: ${palette.windowBg};`);
  });
  it("keeps the series palette for vendors", () => {
    expect(vendorColor("codex")).toBe("var(--ab-vendor-codex)");
    expect(vendorColor(null)).toBe("var(--ab-series-neutral)");
    expect(themeCss).toContain("--ab-vendor-claude: #3987e5;");
  });
});
