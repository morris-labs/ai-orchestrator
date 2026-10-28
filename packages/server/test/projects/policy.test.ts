import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@agentbox/contracts";
import { readPolicy, writePolicy } from "../../src/projects/policy.js";

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
  return path.join(dir, ".claude-box", "policy.yaml");
}

describe("policy file", () => {
  it("returns the default policy for a missing file", () => {
    const file = tempFile();
    expect(readPolicy(file)).toEqual({ path: file, exists: false, policy: DEFAULT_POLICY });
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
});
