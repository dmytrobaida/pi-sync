import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "eslint.config.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  jsdoc.configs["flat/recommended-typescript"],
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "allow" },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: false,
          allowHigherOrderFunctions: false,
          allowTypedFunctionExpressions: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowAny: false,
          allowNullableBoolean: false,
          allowNullableEnum: false,
          allowNullableNumber: false,
          allowNullableObject: false,
          allowNullableString: false,
          allowNumber: false,
          allowString: false,
        },
      ],
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/parameter-properties": [
        "error",
        { prefer: "parameter-property" },
      ],
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "brace-style": ["error", "1tbs", { allowSingleLine: false }],
      curly: ["error", "all"],
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns": "off",
      "jsdoc/tag-lines": "off",
      "preserve-caught-error": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector: "PrivateIdentifier",
          message: "Use TypeScript private/protected fields instead of #private names.",
        },
        {
          selector: "PropertyDefinition > Identifier[name=/^[$_]/]",
          message: "Do not prefix class field names. Use private/protected modifiers for visibility.",
        },
        {
          selector: "IfStatement > AwaitExpression.test, IfStatement > UnaryExpression.test AwaitExpression, IfStatement > LogicalExpression.test AwaitExpression, IfStatement > BinaryExpression.test AwaitExpression, IfStatement > ConditionalExpression.test AwaitExpression, IfStatement > CallExpression.test AwaitExpression",
          message: "Do not await inside conditions. Assign awaited values to named constants before the condition.",
        },
      ],
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
      "max-lines-per-function": [
        "warn",
        { max: 60, skipBlankLines: true, skipComments: true },
      ],
      "simple-import-sort/exports": "error",
      "simple-import-sort/imports": "error",
      "padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        {
          blankLine: "any",
          prev: ["const", "let", "var"],
          next: ["const", "let", "var"],
        },
        {
          blankLine: "always",
          prev: "*",
          next: ["if", "for", "while", "switch", "try", "return", "throw"],
        },
        { blankLine: "always", prev: ["block", "block-like"], next: "*" },
        { blankLine: "always", prev: "*", next: ["block", "block-like"] },
      ],
    },
  },
);
