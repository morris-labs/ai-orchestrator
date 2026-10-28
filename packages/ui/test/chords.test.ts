import { describe, expect, it } from "vitest";
import {
  duplicateChords,
  eventKey,
  findBinding,
  formatChord,
  isApplicationChord,
  matchChord,
  parseChord,
} from "../src/core";

const ev = (
  key: string,
  code: string,
  m: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
) => ({
  key,
  code,
  ctrlKey: !!m.ctrl,
  shiftKey: !!m.shift,
  altKey: !!m.alt,
  metaKey: !!m.meta,
});

describe("chords", () => {
  it("parses and formats", () => {
    expect(parseChord("Ctrl+Shift+N")).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      key: "N",
    });
    expect(formatChord(parseChord("ctrl+shift+right"))).toBe("Ctrl+Shift+Right");
    expect(parseChord("F5").key).toBe("F5");
    expect(() => parseChord("Ctrl+Shift")).toThrow();
  });
  it("matches by physical key", () => {
    expect(eventKey(ev("@", "Digit2"))).toBe("2");
    expect(
      matchChord(ev("N", "KeyN", { ctrl: true, shift: true }), parseChord("Ctrl+Shift+N")),
    ).toBe(true);
    expect(matchChord(ev("n", "KeyN", { ctrl: true }), parseChord("Ctrl+Shift+N"))).toBe(false);
    expect(
      matchChord(
        ev("ArrowRight", "ArrowRight", { ctrl: true, shift: true }),
        parseChord("Ctrl+Shift+Right"),
      ),
    ).toBe(true);
  });
  it.each([
    [ev("N", "KeyN", { ctrl: true, shift: true }), true],
    [ev("3", "Digit3", { alt: true }), true],
    [ev("F5", "F5"), true],
    [ev("F5", "F5", { ctrl: true }), false],
    [ev("n", "KeyN", { ctrl: true }), false],
    [ev("Shift", "ShiftLeft", { ctrl: true, shift: true }), false],
    [ev("x", "KeyX"), false],
  ])("classifies application chords (%#)", (e, expected) => {
    expect(isApplicationChord(e)).toBe(expected);
  });
  it("finds bindings and flags duplicates", () => {
    const run = () => undefined;
    const bindings = [
      { chord: "Ctrl+Shift+A", run },
      { chord: "Ctrl+Shift+J", run },
    ];
    expect(findBinding(ev("J", "KeyJ", { ctrl: true, shift: true }), bindings)).toBe(bindings[1]);
    expect(duplicateChords(bindings)).toEqual([]);
    expect(duplicateChords([...bindings, { chord: "ctrl+shift+a", run }])).toEqual([
      "Ctrl+Shift+A",
    ]);
  });
});
