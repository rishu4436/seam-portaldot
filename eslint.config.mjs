import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
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
      // `any` is tolerated for now (warn) while owners tighten types.
      "@typescript-eslint/no-explicit-any": "warn",
      "no-fallthrough": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      // Unused values are allowed when prefixed with an underscore.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
