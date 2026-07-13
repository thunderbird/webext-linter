// ESLint flat config for ESLint v9+
export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // The Node runtime globals this codebase uses. Declared explicitly (rather than
      // pulled from the `globals` package) so no-undef below has no false positives and
      // the project takes on no dependency for a lint rule.
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: {
      // avoidEscape: allow single quotes (or backticks) for strings that
      // contain a double quote, so eslint agrees with Prettier instead of
      // fighting it over escape-vs-quote-style.
      quotes: ["error", "double", { avoidEscape: true }],
      semi: ["error", "always"],
      curly: ["error", "all"],
      "no-case-declarations": "error",
      // A refactor that moves code between functions can leave an identifier bound in the
      // old scope and dangling in the new one - a hard ReferenceError that the offline test
      // suite cannot see, because it only fires on the LLM paths. This rule catches it.
      "no-undef": "error",
      // Catches dead code the above cannot - a stale import, or a variable left behind when
      // its consumer's signature changed. A leading `_` marks a deliberately-discarded binding
      // (the `{ x: _x, ...rest }` omit idiom in src/report/format.js), so it is exempt.
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];
