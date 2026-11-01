import { describe, expect, it } from "vitest";
import { eventsUrl } from "../src/events.js";
import { jsonText, keyValues, percent, table, terminalText } from "../src/format.js";

describe("format", () => {
  it("aligns table columns and fills empty cells", () => {
    expect(
      table(
        ["A", "LONGER"],
        [
          ["x", null],
          ["long value", 3],
        ],
      ),
    ).toBe("A           LONGER\nx           -\nlong value  3\n");
  });

  it("aligns key-value lines", () => {
    expect(
      keyValues([
        ["Run", "r1"],
        ["Stage", undefined],
      ]),
    ).toBe("Run:   r1\nStage: -\n");
  });

  it("formats percentages", () => {
    expect(percent(0.425)).toBe("43%");
  });

  it("shows control characters as escapes", () => {
    expect(terminalText("a\u001b[2Jb\tc\nd\u007f\u0085")).toBe("a\\x1b[2Jb\tc\nd\\x7f\\x85");
    // A cell is one line, so tabs and newlines are escaped too.
    expect(table(["T"], [["a\nb\tc\u0007"]])).toBe("T\na\\x0ab\\x09c\\x07\n");
    expect(keyValues([["Title", "x\u001b]0;SYNTHETIC\u0007"]])).toBe(
      "Title: x\\x1b]0;SYNTHETIC\\x07\n",
    );
  });

  it("escapes DEL and C1 controls in JSON and keeps it valid", () => {
    const value = { t: "a\u001bb\u007fc\u009bd" };
    const text = jsonText(value);
    expect(text).toBe('{"t":"a\\u001bb\\u007fc\\u009bd"}');
    expect(JSON.parse(text)).toEqual(value);
  });

  it("builds the events URL without a token", () => {
    expect(eventsUrl("http://127.0.0.1:21400/", "a,b")).toBe(
      "ws://127.0.0.1:21400/api/v1/events?types=a%2Cb",
    );
    expect(eventsUrl("https://example.com")).toBe("wss://example.com/api/v1/events");
    expect(eventsUrl("https://example.com/aio/")).toBe("wss://example.com/aio/api/v1/events");
  });
});
