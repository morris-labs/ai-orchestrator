// Runs every workspace package's tests from the repository root with
// `pnpm exec vitest run`. Each package also runs its own tests with
// `pnpm --filter <name> test`. Vitest 4 removed the `vitest.workspace.ts`
// file, so the project list lives here under `test.projects`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "tools/*"],
  },
});
