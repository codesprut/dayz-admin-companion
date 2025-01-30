import js from "@eslint/js";
import ts from "@typescript-eslint/eslint-plugin";
import globals from "globals";

import { includeIgnoreFile } from "@eslint/compat";
import path from "node:path";
import { fileURLToPath } from "node:url";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

export default [
  includeIgnoreFile(gitignorePath),
  js.configs.recommended,
  ts.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.jest,
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "prettier/prettier": "error",
      curly: "error",
    },
  },
];
