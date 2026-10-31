import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kvAll, kvLast, parseKv, readKvFile } from "../../src/import/kv.js";
import { tempDir } from "../tmp.js";

describe("parseKv", () => {
  it("splits at the first equals sign and keeps order and repeats", () => {
    const kv = parseKv("a=1\nport=1:2\nnoequals\nport=3:4\nprompt=x=y\r\nempty=\n");
    expect(kv).toEqual([
      ["a", "1"],
      ["port", "1:2"],
      ["port", "3:4"],
      ["prompt", "x=y"],
      ["empty", ""],
    ]);
    expect(kvAll(kv, "port")).toEqual(["1:2", "3:4"]);
    expect(kvLast(kv, "a")).toBe("1");
    expect(kvLast(kv, "missing")).toBeUndefined();
  });

  it("drops a leading byte order mark", () => {
    expect(parseKv("\uFEFFtarget_dir=/x\nyolo=1\n")).toEqual([
      ["target_dir", "/x"],
      ["yolo", "1"],
    ]);
  });

  it("reads a file", () => {
    const dir = tempDir("kv-");
    const file = path.join(dir, "rec");
    fs.writeFileSync(file, "target_dir=/x\n");
    expect(readKvFile(file)).toEqual([["target_dir", "/x"]]);
  });
});
