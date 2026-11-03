import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@aio/contracts";
import { readPolicy, writePolicy } from "../../src/projects/policy.js";
import { tempDir } from "../tmp.js";

function tempFile(): string {
  const dir = tempDir("policy-");
  return path.join(dir, ".aio", "policy.yaml");
}

describe("policy file", () => {
  it("returns the default policy for a missing file", () => {
    const file = tempFile();
    expect(readPolicy(file)).toEqual({
      path: file,
      exists: false,
      policy: DEFAULT_POLICY,
      text: null,
      revision: "absent",
    });
  });

  it("writes YAML and reads it back with defaults filled", () => {
    const file = tempFile();
    const written = writePolicy(file, {
      ...DEFAULT_POLICY,
      rules: [{ id: "r1", text: "Never log a token." }],
    });
    expect(fs.readFileSync(file, "utf8")).toContain("text: Never log a token.");
    expect(readPolicy(file)).toEqual(written);
  });

  it("refuses invalid YAML and unknown keys", () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "version: [1\n");
    expect(() => readPolicy(file)).toThrow(expect.objectContaining({ code: "validation" }));
    fs.writeFileSync(file, "version: 1\nrisk_paths: []\n");
    expect(() => readPolicy(file)).toThrow(expect.objectContaining({ code: "validation" }));
    expect(() => writePolicy(file, { version: 2 } as never)).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
  });

  it("reads an empty file as the default policy", () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    expect(readPolicy(file).policy).toEqual(DEFAULT_POLICY);
  });

  it("refuses a put whose base revision is out of date, and leaves the file", () => {
    const file = tempFile();
    const first = readPolicy(file);
    writePolicy(file, { text: "version: 1\n" }, first.revision);
    const loaded = readPolicy(file);
    // Someone edits the file on disk after the editor loaded it.
    fs.writeFileSync(file, "version: 1\nriskPaths: [src/**]\n");
    expect(() =>
      writePolicy(file, { ...DEFAULT_POLICY, groupSizeLimit: 9 }, loaded.revision),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(fs.readFileSync(file, "utf8")).toBe("version: 1\nriskPaths: [src/**]\n");
    // Without a base revision, the put overwrites.
    expect(writePolicy(file, { ...DEFAULT_POLICY, groupSizeLimit: 9 }).policy.groupSizeLimit).toBe(
      9,
    );
    // A default limit stays out of a file written from a policy object.
    expect(writePolicy(file, DEFAULT_POLICY).text).not.toContain("groupSizeLimit");
    // A put against a missing file's revision fails once the file exists.
    const other = tempFile();
    const missing = readPolicy(other).revision;
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "version: 1\n");
    expect(() => writePolicy(other, { text: "version: 1\n" }, missing)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
  });

  it("writes policy text as it is, comments and key order included", () => {
    const file = tempFile();
    const text =
      "# keep in sync with CI\nversion: 1\ntests:\n  - command: npm test # the fast suite\nriskPaths: []\n";
    const r = writePolicy(file, { text });
    expect(fs.readFileSync(file, "utf8")).toBe(text);
    expect(r.policy.tests).toEqual([{ command: "npm test" }]);
    expect(readPolicy(file)).toEqual(r);
    expect(r.text).toBe(text);
    expect(() => writePolicy(file, { text: "version: 2\n" })).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
    expect(() => writePolicy(file, { text: "version: [1\n" })).toThrow(
      expect.objectContaining({ code: "validation" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });
});
