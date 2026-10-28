import { describe, expect, it } from "vitest";
import { isAllowedOpenPath, isAppPage, isWebUrl } from "../src/core";

describe("isAppPage", () => {
  const pages = ["http://127.0.0.1:20400/boxes/", "file:///opt/agentbox/renderer/index.html"];

  it("accepts the app's own pages", () => {
    expect(isAppPage("http://127.0.0.1:20400/boxes/", pages)).toBe(true);
    expect(isAppPage("http://127.0.0.1:20400/boxes/index.html?x=1#/a", pages)).toBe(true);
    expect(isAppPage("http://127.0.0.1:20400/boxes", pages)).toBe(true);
    expect(isAppPage("file:///opt/agentbox/renderer/index.html#/", pages)).toBe(true);
  });

  it("rejects other origins, paths, and files", () => {
    expect(isAppPage("http://3000.key.localhost:20400/", pages)).toBe(false);
    expect(isAppPage("http://127.0.0.1:20401/boxes/", pages)).toBe(false);
    expect(isAppPage("http://127.0.0.1:20400/review/", pages)).toBe(false);
    expect(isAppPage("http://127.0.0.1:20400/boxes-evil/", pages)).toBe(false);
    expect(isAppPage("https://127.0.0.1:20400/boxes/", pages)).toBe(false);
    expect(isAppPage("file:///tmp/evil.html", pages)).toBe(false);
    expect(isAppPage("not a url", pages)).toBe(false);
    expect(isAppPage("", pages)).toBe(false);
  });
});

describe("isWebUrl", () => {
  it("accepts only http and https", () => {
    expect(isWebUrl("https://example.com/pr/1")).toBe(true);
    expect(isWebUrl("http://example.com")).toBe(true);
    expect(isWebUrl("file:///tmp/x.desktop")).toBe(false);
    expect(isWebUrl("smb://example.com/share")).toBe(false);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("nope")).toBe(false);
  });
});

describe("isAllowedOpenPath", () => {
  const roots = ["/home/user/src/app", "/home/user/src/other/"];

  it("accepts a reported directory", () => {
    expect(isAllowedOpenPath("/home/user/src/app", roots)).toBe(true);
    expect(isAllowedOpenPath("/home/user/src/app/", roots)).toBe(true);
    expect(isAllowedOpenPath("/home/user/src/other", roots)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isAllowedOpenPath("/home/user/src/app/run.desktop", roots)).toBe(false);
    expect(isAllowedOpenPath("/home/user/src/app/../app", roots)).toBe(false);
    expect(isAllowedOpenPath("relative/app", roots)).toBe(false);
    expect(isAllowedOpenPath("/", roots)).toBe(false);
    expect(isAllowedOpenPath("/home/user/src/app", [])).toBe(false);
  });
});
