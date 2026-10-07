import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import ts from "typescript-eslint";
import vue from "eslint-plugin-vue";

const sourceFiles = ["apps/web/src/**/*.{ts,vue}", "packages/**/*.ts"];
const vueFiles = ["apps/web/src/**/*.vue"];

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".runtime/**",
      "packages/protocol/**",
    ],
  },
  {
    files: sourceFiles,
    extends: [js.configs.recommended, ...ts.configs.recommended],
    languageOptions: { globals: { ...globals.browser, ...globals.es2022 } },
    rules: {
      // Boundary adapters narrow unknown SDK payloads at runtime.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  ...vue.configs["flat/essential"].map((config) => ({
    ...config,
    files: vueFiles,
  })),
  {
    files: vueFiles,
    languageOptions: { parserOptions: { parser: ts.parser } },
    rules: { "vue/multi-word-component-names": "off" },
  },
  {
    files: ["apps/web/src/**/*worker.ts"],
    languageOptions: { globals: globals.worker },
  },
);
