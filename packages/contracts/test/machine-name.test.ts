import { describe, expect, it } from "vitest";
import { EnrollMachineNameSchema, MachineNameSchema } from "../src/index.js";

describe("EnrollMachineNameSchema", () => {
  it("refuses the reserved names in any case", () => {
    for (const name of ["local", "hub", "Local", "HUB"]) {
      expect(EnrollMachineNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("accepts an ordinary name, and stored reserved names still parse", () => {
    expect(EnrollMachineNameSchema.safeParse("laptop-1").success).toBe(true);
    expect(MachineNameSchema.safeParse("local").success).toBe(true);
  });
});
