import { describe, expect, it } from "vitest";
import { isAllowedOpenPath } from "../src/core";

describe("isAllowedOpenPath on each host", () => {
  it("keeps the POSIX rules on Linux and macOS", () => {
    for (const os of ["linux", "darwin"] as const) {
      expect(isAllowedOpenPath("/Users/alex/src/app/", ["/Users/alex/src/app"], os)).toBe(true);
      expect(isAllowedOpenPath("C:\\src\\app", ["C:\\src\\app"], os)).toBe(false);
    }
  });

  it("accepts Windows drive paths with either separator and any case", () => {
    const roots = ["C:\\Users\\alex\\src\\app"];
    expect(isAllowedOpenPath("C:\\Users\\alex\\src\\app", roots, "win32")).toBe(true);
    expect(isAllowedOpenPath("C:/Users/alex/src/app/", roots, "win32")).toBe(true);
    expect(isAllowedOpenPath("c:\\users\\ALEX\\src\\app\\", roots, "win32")).toBe(true);
    expect(isAllowedOpenPath("D:\\Users\\alex\\src\\app", roots, "win32")).toBe(false);
  });

  it("refuses UNC, device, relative, root, and parent paths on Windows", () => {
    const roots = ["C:\\src\\app", "\\\\server\\share\\app", "C:\\"];
    expect(isAllowedOpenPath("\\\\server\\share\\app", roots, "win32")).toBe(false);
    expect(isAllowedOpenPath("//server/share/app", roots, "win32")).toBe(false);
    expect(isAllowedOpenPath("\\\\?\\C:\\src\\app", roots, "win32")).toBe(false);
    expect(isAllowedOpenPath("src\\app", roots, "win32")).toBe(false);
    expect(isAllowedOpenPath("C:src\\app", roots, "win32")).toBe(false);
    expect(isAllowedOpenPath("C:\\", roots, "win32")).toBe(false);
    expect(isAllowedOpenPath("C:\\src\\app\\..\\app", roots, "win32")).toBe(false);
    expect(isAllowedOpenPath("/src/app", ["/src/app"], "win32")).toBe(false);
  });
});
