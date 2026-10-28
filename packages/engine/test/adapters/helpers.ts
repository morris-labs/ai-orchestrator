// Shared test helpers for the adapter tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dirname, "fixtures");
export const MOCK_BIN = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "tools",
  "mock-clis",
  "bin",
);

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

export function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}
