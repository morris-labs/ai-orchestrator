// Flat ESLint configuration for every TypeScript package in the workspace.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/test-results/**",
      "TestBox/**",
      ".worktrees/**",
      // Per-conversation notes and review run checkouts, which Git ignores.
      ".aio/**",
      ".claude/**",
      ".pnpm-store/**",
      "scripts/**",
      // Runtime trees that scripts/stage-runtime.mjs assembles.
      "packaging/build/**",
      "packaging/deb/build/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
