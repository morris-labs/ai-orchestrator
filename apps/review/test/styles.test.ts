// Checks the launcher form's layout rules. jsdom does no layout, so the test
// loads the app stylesheet and reads the computed styles that keep each
// fieldset inside its grid track: without them, a select with a long option
// widens its fieldset over the next column.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const STYLES = path.join(import.meta.dirname, "../src/styles.css");

describe("the launcher form styles", () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = document.createElement("style");
    style.textContent = readFileSync(STYLES, "utf8");
    document.head.append(style);
    document.body.innerHTML = `
      <form class="form-grid">
        <fieldset class="form-contents">
          <fieldset>
            <legend>Where</legend>
            <select><option>/home/user/src/example-app/.worktrees/a-long-branch-name</option></select>
          </fieldset>
        </fieldset>
      </form>`;
  });

  afterEach(() => {
    style.remove();
    document.body.innerHTML = "";
  });

  it("lets a fieldset shrink to its grid track", () => {
    const fieldset = document.querySelector("fieldset:not(.form-contents)")!;
    const css = getComputedStyle(fieldset);
    expect(css.minWidth).toBe("0px");
    expect(css.gridTemplateColumns).toBe("minmax(0, 1fr)");
  });

  it("sizes a select to its fieldset, not to its longest option", () => {
    const css = getComputedStyle(document.querySelector("select")!);
    expect(css.width).toBe("100%");
    expect(css.maxWidth).toBe("100%");
    expect(css.minWidth).toBe("0px");
  });
});
