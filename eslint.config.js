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
      // old scope and dangling in the new one - a hard ReferenceError. The offline test
      // suite cannot see one that sits on a networked path, since it stubs the vendor
      // fetch and the OSV audit out, so this rule is what catches it there.
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
      // ONE PARSER. Every file this tool reads is somebody else's bytes - a submission's
      // manifest, a lock, an Experiment schema, an agent's hand-back - and a reader that
      // calls JSON.parse itself carries its own tolerances. The one every hand-written
      // reader forgot was the BOM: JSON.parse throws on it, the tools that write these
      // files do not, so a good file reads as absent and every caller's empty case
      // swallows it silently. That shipped four times in four readers before this rule
      // existed. parseJson (src/util/json.js) is the only permitted call site; it strips
      // the BOM and answers null for every failure alike.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='JSON'][property.name='parse']",
          message:
            "Use parseJson from src/util/json.js - it strips the BOM and returns null. Direct JSON.parse is allowed only inside that module.",
        },
      ],
    },
  },
  {
    // The one parser. Nothing else in the project may call JSON.parse.
    files: ["src/util/json.js"],
    rules: { "no-restricted-syntax": "off" },
  },
];
