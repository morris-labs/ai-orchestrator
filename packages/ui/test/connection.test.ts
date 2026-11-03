import { describe, expect, it } from "vitest";
import { connectionPageUrl, parseConnectionAction } from "../src/electron/connection";

describe("the connection window", () => {
  it("reads only its own actions", () => {
    expect(parseConnectionAction("aio-connection://local?")).toEqual({ action: "local" });
    expect(
      parseConnectionAction(
        "aio-connection://enroll?hubUrl=https%3A%2F%2Fhub.example.com%3A21403&code=AAAA-BBBB&name=desk",
      ),
    ).toEqual({
      action: "enroll",
      hubUrl: "https://hub.example.com:21403",
      code: "AAAA-BBBB",
      name: "desk",
    });
    expect(parseConnectionAction("https://example.com/")).toBeNull();
    expect(parseConnectionAction("aio-connection://other")).toBeNull();
    expect(parseConnectionAction("not a url")).toBeNull();
  });

  it("escapes what it shows and allows no script", () => {
    const url = connectionPageUrl({ mode: "local", hub: null }, '"><img>', "<script>");
    const html = Buffer.from(url.split("base64,")[1] as string, "base64").toString();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('"><img>');
    expect(html).toContain("default-src 'none'");
  });
});
