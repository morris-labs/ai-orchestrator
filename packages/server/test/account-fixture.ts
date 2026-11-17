// Account records for tests whose temporary home is intentionally under /tmp.
import fs from "node:fs";
import path from "node:path";
import type { ServerCore } from "../src/core.js";
import { accountDirFor, dataDirOf } from "../src/records/env.js";

export function configureTestAccounts(core: ServerCore): void {
  const defaults: Record<string, string> = {};
  for (const vendor of ["claude", "codex", "copilot"] as const) {
    const name = "test";
    const id = `${vendor}/${name}`;
    const dir = accountDirFor(core.env, vendor, name);
    fs.mkdirSync(dir, { recursive: true });
    if (vendor === "claude") {
      const store = path.join(dataDirOf(core.env), "transcripts", "claude");
      fs.mkdirSync(store, { recursive: true });
      fs.symlinkSync(store, path.join(dir, "projects"));
    }
    const time = "2026-11-17T00:00:00Z";
    core.db.accounts.put({
      id,
      vendor,
      name,
      label: name,
      overflow: false,
      signIn: { state: "signed_in" },
      createdAt: time,
      updatedAt: time,
    });
    defaults[vendor] = id;
  }
  core.settings.patch({ accountsMode: "accounts", accountDefaults: defaults });
}
