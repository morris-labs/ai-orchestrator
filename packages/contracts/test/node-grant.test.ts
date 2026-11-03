import { describe, expect, it } from "vitest";
import { GlobalSettingsInputSchema, NodeGrantSchema } from "../src/index.js";

describe("NodeGrantSchema", () => {
  const key = "host/claude/.credentials.json";

  it("strips the removed signInUpdates field from stored settings", () => {
    const grant = NodeGrantSchema.parse({ signInCopies: [key], signInUpdates: [key] });
    expect(grant).toEqual({ opRefs: [], opVaults: [], signInCopies: [key] });
    const settings = GlobalSettingsInputSchema.parse({
      nodeGrants: { m1: { signInCopies: [], signInUpdates: [key] } },
    });
    expect(settings.nodeGrants?.m1).toEqual({ opRefs: [], opVaults: [], signInCopies: [] });
  });

  it("still refuses any other unknown field", () => {
    expect(NodeGrantSchema.safeParse({ somethingElse: [] }).success).toBe(false);
  });
});
