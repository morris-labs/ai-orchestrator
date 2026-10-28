import { expect } from "vitest";
import type { z } from "zod";

/**
 * Parses `input`, serializes the result to JSON, parses it again, and checks
 * that both parses agree. Returns the first parse.
 */
export function roundTrip<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const first = schema.parse(input);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return first;
}
