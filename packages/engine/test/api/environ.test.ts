// The engine's own `/proc/PID/environ` holds no credential after startup.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { looksLikeCredential } from "../../src/process/env.js";
import { tempDir } from "../tmp.js";

// The child process imports the built module. Node.js 22 can't run a
// TypeScript source file, and the source imports use `.js` specifiers that
// only a bundler or a TypeScript-aware loader resolves. `pnpm test` builds
// every package first; run `pnpm --filter @agentbox/engine build` before a
// bare `vitest run`.
const environModule = fileURLToPath(new URL("../../dist/main/environ.js", import.meta.url));

describe("moveSecretsOutOfEnviron", () => {
  it.runIf(process.platform === "linux")(
    "re-executes the process so its environ drops the token, and restores process.env",
    () => {
      expect(existsSync(environModule), `${environModule} is missing; build the engine first`).toBe(
        true,
      );
      const dir = tempDir("engine-environ-");
      const script = path.join(dir, "child.mjs");
      writeFileSync(
        script,
        [
          `import { readFileSync } from "node:fs";`,
          `import { moveSecretsOutOfEnviron } from ${JSON.stringify(environModule)};`,
          `const step = moveSecretsOutOfEnviron({ isSecret: (n) => n.startsWith("SYNTHETIC_") });`,
          `const environ = readFileSync("/proc/self/environ", "utf8");`,
          `console.log(JSON.stringify({`,
          `  step,`,
          `  inEnviron: environ.includes("SYNTHETIC_SECRET_VALUE"),`,
          `  token: process.env.SYNTHETIC_ENGINE_TOKEN ?? null,`,
          `  movedFile: process.env.AGENTBOX_ENGINE_MOVED_ENV_FILE ?? null,`,
          `  args: process.argv.slice(2),`,
          `}));`,
          "",
        ].join("\n"),
      );
      const out = execFileSync(process.execPath, [script, "--log-level", "info"], {
        env: { ...process.env, SYNTHETIC_ENGINE_TOKEN: "SYNTHETIC_SECRET_VALUE" },
        encoding: "utf8",
      });
      const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
        step: { kind: string; restored: number };
        inEnviron: boolean;
        token: string | null;
        movedFile: string | null;
        args: string[];
      };
      expect(result.step).toEqual({ kind: "ready", restored: 1 });
      expect(result.inEnviron).toBe(false);
      expect(result.token).toBe("SYNTHETIC_SECRET_VALUE");
      expect(result.movedFile).toBeNull();
      expect(result.args).toEqual(["--log-level", "info"]);
    },
  );

  it("treats the engine token and vendor and GitHub credentials as secrets", () => {
    for (const name of ["AGENTBOX_ENGINE_TOKEN", "GH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
      expect(looksLikeCredential(name)).toBe(true);
    for (const name of ["PATH", "HOME", "AGENTBOX_PROJECT_ROOT", "TOKENIZER_PATH"])
      expect(looksLikeCredential(name)).toBe(false);
    expect(existsSync(environModule)).toBe(true);
  });
});
