#!/usr/bin/env node
// Checks the one-time import against the host's real ~/.claude-box without
// touching it: the records are copied to a temporary home, imported into a
// temporary database, and every box is checked against its transcript in the
// real ~/.claude/projects. See README.md in this directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boxWorkDir, projectContainerName } from "@agentbox/contracts";
import {
  createCore,
  defaultHostEnv,
  projectIdForRoot,
  readKvFile,
  runImport,
  kvLast,
  transcriptExists,
  transcriptPath,
} from "../../dist/core.js";

const real = defaultHostEnv();
const source = path.join(real.home, ".claude-box");
const conf = path.join(real.home, ".config/claude-box/claude-box.conf");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-import-")));
for (const entry of ["known", "projects", "global", "ssh_remotes"]) {
  const from = path.join(source, entry);
  if (fs.existsSync(from))
    fs.cpSync(from, path.join(tmp, ".claude-box", entry), { recursive: true });
}

const env = { ...real, home: tmp };
const core = createCore({
  engineVersion: "import-check",
  env,
  dbPath: path.join(tmp, "agentbox.db"),
});
let failures = 0;
try {
  const report = runImport({ env, repos: core.db, confPath: conf });
  console.log(JSON.stringify({ ...report, filesRead: report.filesRead.length }, null, 2));
  if (report.boxes.skipped.length > 0) failures += report.boxes.skipped.length;

  console.log("\nbox | 3.3.5 container/session -> 4.0 container/session | transcript");
  for (const box of core.db.boxes.list()) {
    const record = readKvFile(path.join(source, "known", box.id));
    const oldContainer = kvLast(record, "container") || box.id;
    const oldSession = kvLast(record, "session") || "main";
    const expected = projectContainerName(projectIdForRoot(box.targetDir));
    const containerOk = box.container === expected;
    let transcript = "no session";
    if (box.sessionUuid) {
      const found = await transcriptExists(real, boxWorkDir(box), box.sessionUuid);
      transcript = found
        ? "found"
        : `MISSING ${transcriptPath(real, boxWorkDir(box), box.sessionUuid)}`;
    }
    if (!containerOk) failures += 1;
    console.log(
      `${box.id} | ${oldContainer}/${oldSession} -> ${box.container}/${box.session}${containerOk ? "" : ` (expected ${expected})`} | ${transcript}`,
    );
  }
  for (const p of core.db.projects.list()) {
    console.log(
      `project ${p.id} root=${p.root} mounts=${p.mounts.length} tcpMaps=${JSON.stringify(p.tcpMaps)}`,
    );
  }
  const again = runImport({ env, repos: core.db, confPath: conf });
  if (again.boxes.imported.length > 0 || again.projects.imported.length > 0) {
    console.log("A second import changed records.");
    failures += 1;
  }
} finally {
  core.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(
  failures === 0 ? "\nImport check passed." : `\nImport check found ${failures} problem(s).`,
);
process.exitCode = failures === 0 ? 0 : 1;
