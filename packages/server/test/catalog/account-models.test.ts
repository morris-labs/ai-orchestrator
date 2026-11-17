import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeHarness } from "../boxes/harness.js";
import { accountDirFor } from "../../src/records/env.js";

describe("models belong to the selected account", () => {
  it("ignores host and project settings and reads only the account's model options and defaults", async () => {
    const h = makeHarness();
    fs.mkdirSync(path.join(h.home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(h.home, ".claude.json"),
      JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-opus-99" }] }),
    );
    fs.writeFileSync(
      path.join(h.home, ".claude", "settings.json"),
      JSON.stringify({ model: "host-model", effortLevel: "low" }),
    );
    const project = h.dir("work", ".claude");
    fs.writeFileSync(
      path.join(project, "settings.json"),
      JSON.stringify({ model: "project-model", effortLevel: "max" }),
    );
    const account = accountDirFor(h.env, "claude", "fixture");
    fs.writeFileSync(
      path.join(account, ".claude.json"),
      JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-opus-12" }] }),
    );
    fs.writeFileSync(
      path.join(account, "settings.json"),
      JSON.stringify({ model: "account-model", effortLevel: "medium" }),
    );
    const models = await h.core.models.list(path.dirname(project));
    expect(models.models).toContain("claude-opus-12");
    expect(models.models).not.toContain("claude-opus-99");
    expect(models.defaults).toEqual({ model: "account-model", effort: "medium" });
    h.core.settings.patch({ accountsMode: "host" });
    const withoutAccount = await h.core.models.list(path.dirname(project));
    expect(withoutAccount.models).not.toContain("claude-opus-99");
    expect(withoutAccount.defaults).toEqual({ model: "claude-opus-5-5", effort: "high" });
  });
});
