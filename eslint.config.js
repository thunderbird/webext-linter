// ESLint flat config for ESLint v9+
export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      // avoidEscape: allow single quotes (or backticks) for strings that
      // contain a double quote, so eslint agrees with Prettier instead of
      // fighting it over escape-vs-quote-style.
      quotes: ["error", "double", { avoidEscape: true }],
      semi: ["error", "always"],
      curly: ["error", "all"],
      "no-case-declarations": "error",
    },
  },
];
