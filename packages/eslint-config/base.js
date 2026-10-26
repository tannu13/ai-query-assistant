import { createRequire } from "node:module";

import babelParser from "@babel/eslint-parser";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import onlyWarn from "eslint-plugin-only-warn";
import turboPlugin from "eslint-plugin-turbo";

/**
 * Resolves Babel plugins from THIS package rather than from the package being
 * linted. A bare preset name is resolved relative to the linted file, so any
 * consumer that does not itself depend on Babel fails with
 * "Cannot find package '@babel/preset-typescript'".
 */
const require = createRequire(import.meta.url);

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  {
    /**
     * ESLint's default file set is js/mjs/cjs only. Without naming TypeScript
     * here, a TS-only package lints "clean" because its source is never read.
     */
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: [require.resolve("@babel/preset-typescript")],
        },
      },
    },
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
  {
    /**
     * Core ESLint rules that need type information are off for TypeScript,
     * because the Babel parser strips types without understanding them:
     *
     * - `no-undef`: TypeScript resolves identifiers itself, so this only
     *   misfires on types and ambient globals.
     * - `no-unused-vars`: type-only imports and type positions are invisible
     *   to the parser, so every `import type` reads as unused.
     *
     * Normally `typescript-eslint` replaces both with type-aware equivalents,
     * but no release supports TypeScript 7 yet (peer range caps at <6.1.0).
     * `tsc` covers the same ground via `noUnusedLocals` when it is enabled.
     */
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
  {
    plugins: {
      onlyWarn,
    },
  },
  {
    ignores: ["dist/**", "node_modules/**"],
  },
];
