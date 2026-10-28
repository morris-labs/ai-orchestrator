import { describe, expect, it } from "vitest";
import {
  decodeIniKey,
  parseIniValue,
  parseQtIni,
  qtBool,
  qtList,
  qtString,
} from "../../src/import/qsettings.js";

describe("parseIniValue", () => {
  it("unescapes quoted and unquoted text", () => {
    expect(parseIniValue('"Say \\"hi\\", then\\nread it."')).toBe('Say "hi", then\nread it.');
    expect(parseIniValue("Line one\\nLine two")).toBe("Line one\nLine two");
    expect(parseIniValue("  spaced  words  ")).toBe("spaced  words");
    expect(parseIniValue('" kept "')).toBe(" kept ");
    expect(parseIniValue("tab\\there\\\\back")).toBe("tab\there\\back");
    expect(parseIniValue("\\a\\b\\f\\r\\v\\0")).toBe("\x07\b\f\r\v\0");
    expect(parseIniValue("dash \\x2014 here")).toBe("dash — here");
    expect(parseIniValue("oct\\101")).toBe("octA");
  });

  it("reads lists, invalid, byte arrays, and at-escapes", () => {
    expect(parseIniValue("a, b,c")).toEqual(["a", "b", "c"]);
    expect(parseIniValue('"a, b", c')).toEqual(["a, b", "c"]);
    expect(parseIniValue("@Invalid()")).toEqual([]);
    expect(parseIniValue("@ByteArray(raw)")).toBe("raw");
    expect(parseIniValue("@Variant(\\0\\0)")).toBeNull();
    expect(parseIniValue("@@literal")).toBe("@literal");
    expect(parseIniValue("")).toBe("");
  });
});

describe("decodeIniKey", () => {
  it("decodes percent escapes and turns backslashes into slashes", () => {
    expect(decodeIniKey("%U00E9t%C3%A9")).toBe("été");
    expect(decodeIniKey("a%20b")).toBe("a b");
    expect(decodeIniKey("group\\key")).toBe("group/key");
  });
});

describe("parseQtIni", () => {
  it("groups keys by section and treats General as no group", () => {
    const ini = parseQtIni(
      [
        "[General]",
        "top=1",
        "; comment",
        "",
        "[prompts]",
        'starter="Hello, \\"you\\"\\nbye"',
        "[newBox]",
        "workspaceDirs=/a, !/b",
        "worktreeDirs=!/c",
        "[setup]",
        "completed=true",
        "other=false",
        "long=first\\",
        "second",
      ].join("\n"),
    );
    expect(ini.get("top")).toBe("1");
    expect(ini.get("prompts/starter")).toBe('Hello, "you"\nbye');
    expect(qtList(ini.get("newBox/workspaceDirs"))).toEqual(["/a", "!/b"]);
    expect(qtList(ini.get("newBox/worktreeDirs"))).toEqual(["!/c"]);
    expect(qtBool(ini.get("setup/completed"))).toBe(true);
    expect(qtBool(ini.get("setup/other"))).toBe(false);
    expect(ini.get("setup/long")).toBe("firstsecond");
    expect(qtString(ini.get("newBox/workspaceDirs"))).toBeUndefined();
    expect(qtBool(undefined)).toBeUndefined();
  });
});
