// Regression tests for small server rules that a whole-project review found.
import { describe, expect, it } from "vitest";
import { candidatesFor } from "../src/secrets/secrets-service.js";
import { copyIdArgv } from "../src/ssh/tunnels.js";
import { sampleIsOver } from "../src/usage/usage-service.js";

const field = (label: string, id = `id-${label}`) => ({ id, label, type: "CONCEALED" });

describe("candidatesFor", () => {
  it("uses ids for names a secret reference can't hold", () => {
    const [c] = candidatesFor("vault", [
      { id: "item1", title: "Db (prod)", fields: [field("user@example.com", "f1")] },
    ] as never);
    expect(c?.ref).toBe("op://vault/item1/f1");
  });

  it("uses ids for repeated item titles and field labels", () => {
    const out = candidatesFor("vault", [
      { id: "a", title: "Same", fields: [field("token", "f1"), field("token", "f2")] },
      { id: "b", title: "Same", fields: [field("other", "f3")] },
    ] as never);
    expect(out.map((c) => c.ref)).toEqual([
      "op://vault/a/f1",
      "op://vault/a/f2",
      "op://vault/b/other",
    ]);
  });

  it("keeps plain names", () => {
    const [c] = candidatesFor("vault", [
      { id: "a", title: "My item", fields: [field("password")] },
    ] as never);
    expect(c?.ref).toBe("op://vault/My item/password");
  });
});

describe("copyIdArgv", () => {
  it("expands a leading tilde in the identity", () => {
    const argv = copyIdArgv(
      { name: "r", host: "user@example.com", identity: "~/.ssh/key" } as never,
      "/home/user",
    );
    expect(argv).toContain("/home/user/.ssh/key.pub");
  });
});

describe("sampleIsOver", () => {
  const sample = {
    window: "5h",
    utilization: 0.1,
    spendUsd: null,
    resetAt: "2000-01-01T00:00:00.000Z",
  };

  it("keeps a zero ceiling blocking after the sample's reset time", () => {
    const ceiling = { kind: "utilization", window: "5h", max: 0 };
    expect(sampleIsOver(sample as never, ceiling as never, Date.now())).toBe(true);
  });

  it("treats a passed reset as reset for any other ceiling", () => {
    const ceiling = { kind: "utilization", window: "5h", max: 0.05 };
    expect(sampleIsOver(sample as never, ceiling as never, Date.now())).toBe(false);
  });
});
