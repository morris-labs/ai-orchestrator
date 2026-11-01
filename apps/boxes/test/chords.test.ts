import { duplicateChords, findBinding, isApplicationChord, parseChord } from "@aio/ui";
import { describe, expect, it } from "vitest";
import { CHORDS } from "../src/app/chords";

describe("application chords", () => {
  const bindings = Object.entries(CHORDS).map(([name, chord]) => ({ chord, run: () => name }));
  it("has no duplicate chord", () => {
    expect(duplicateChords(bindings)).toEqual([]);
  });
  it("resolves the 3.3.5 Ctrl+Shift+A clash: Stop All keeps it, Attach moves to Ctrl+Shift+J", () => {
    expect(CHORDS.stopAll).toBe("Ctrl+Shift+A");
    expect(CHORDS.attach).toBe("Ctrl+Shift+J");
    const ev = {
      key: "J",
      code: "KeyJ",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    };
    expect(findBinding(ev, bindings)?.run()).toBe("attach");
  });
  it("uses only application chords, so every other key reaches the terminal", () => {
    for (const chord of Object.values(CHORDS)) {
      const c = parseChord(chord);
      const code = /^[A-Z]$/.test(c.key) ? `Key${c.key}` : c.key;
      expect(
        isApplicationChord({
          key: c.key,
          code,
          ctrlKey: c.ctrl,
          shiftKey: c.shift,
          altKey: c.alt,
          metaKey: c.meta,
        }),
      ).toBe(true);
    }
  });
  it("leaves Ctrl+Shift+C and Ctrl+Shift+V to the terminal's copy and paste", () => {
    expect(Object.values(CHORDS)).not.toContain("Ctrl+Shift+C");
    expect(Object.values(CHORDS)).not.toContain("Ctrl+Shift+V");
  });
});
