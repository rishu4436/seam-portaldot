import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      ".vercel/**",
      ".seam-defi/**",
      "packages/defi/artifacts/**",
      "packages/defi/cache/**",
      "evidence/**",
      "fixtures/**",
      "packages/console/dist/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // Keep runtime and evidence boundaries typed, with explicit control flow.
      "@typescript-eslint/no-explicit-any": "error",
      "no-fallthrough": "error",
      "@typescript-eslint/no-unused-expressions": "error",
      // Unused values are allowed when prefixed with an underscore.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
