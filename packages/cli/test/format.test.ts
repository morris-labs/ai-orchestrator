import { describe, expect, it } from "vitest";
import { eventsUrl } from "../src/events.js";
import { keyValues, percent, table } from "../src/format.js";

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

  it("builds the events URL", () => {
    expect(eventsUrl("http://127.0.0.1:20400/", "t k", "a,b")).toBe(
      "ws://127.0.0.1:20400/api/v1/events?token=t+k&types=a%2Cb",
    );
    expect(eventsUrl("https://example.com", "t")).toBe("wss://example.com/api/v1/events?token=t");
  });
});
