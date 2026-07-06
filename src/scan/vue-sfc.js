// Splits a Vue Single-File Component (.vue) into the JavaScript the review must
// scan. A .vue file is not a format the checks understand directly, but every
// security-relevant part of it IS JavaScript once you look:
//   - <script> / <script setup> blocks are JS/TS modules, extracted verbatim
//     (exactly like an HTML inline <script>), with the block's `lang` attribute
//     selecting the parse mode (ts/tsx/jsx) through JsSource.parseAs.
//   - a <template> binding value is a JS expression: `@click="fetch(x)"`,
//     `:src="u"`, `v-html="markup"`. Each is lifted into an equivalent JsSource
//     so the ordinary extractors (network-sinks, unsafe-html, ...) scan it with
//     no new plumbing. `v-html` is lifted to an `el.innerHTML = (expr)` write
//     because that is exactly the sink it is; every other binding becomes a bare
//     parenthesised expression, so its value is still scanned for sinks (a
//     `fetch` in an `@click`) without inventing a false HTML sink.
//
// Reuses the parse5 element walk (src/scan/html-parse.js) - the same front door
// the HTML inline-script extractor uses - so quoting, line positions and the
// <template> content fragment are handled by a real parser, not regexes.
//
// Belongs here: turning .vue bytes into a JsSource[]. Does NOT belong here:
// parsing the JS (src/parse/ast.js) or the sink verdicts (src/parse/*,
// src/checks/rules/*).

import { eachElement } from "./html-parse.js";

/**
 * Extract every JavaScript source a .vue SFC contributes: its <script> blocks
 * and its template binding expressions.
 * @param {string} file  Add-on-relative path of the .vue file.
 * @param {string} text  Full SFC source.
 * @returns {import("../addon/sources.js").JsSource[]}
 */
export function extractVueSfc(file, text) {
  const out = [];
  eachElement(
    text,
    (el) => {
      if (el.tag === "script") {
        if (el.rawText && el.rawText.value.trim() !== "") {
          out.push({
            file,
            code: el.rawText.value,
            lineOffset: el.rawText.startLine - 1,
            inline: true,
            parseAs: extForLang(el.attr("lang")),
          });
        }
        return;
      }
      for (const a of el.attrList) {
        const src = bindingSource(file, a);
        if (src) {
          out.push(src);
        }
      }
    },
    { intoTemplates: true }
  );
  return out;
}

/**
 * The parse-mode extension for a `<script lang="...">` block. An unset or plain
 * lang parses as JavaScript.
 * @param {string|null} lang
 * @returns {string}
 */
function extForLang(lang) {
  switch ((lang || "").toLowerCase()) {
    case "ts":
      return ".ts";
    case "tsx":
      return ".tsx";
    case "jsx":
      return ".jsx";
    default:
      return ".js";
  }
}

/**
 * Lift one template attribute into a JsSource, or null when it is not a directive
 * carrying a scannable expression. Directives are Vue's `:x` / `v-bind:x` bindings,
 * `@x` / `v-on:x` handlers and other `v-*` expressions; `v-for` (its `x in xs` is
 * not a plain expression) and `v-slot` (a destructuring pattern) are skipped.
 * @param {string} file
 * @param {{name: string, value: string, line: number}} a
 * @returns {import("../addon/sources.js").JsSource|null}
 */
function bindingSource(file, a) {
  const { name } = a;
  const isDirective =
    name.startsWith(":") || name.startsWith("@") || name.startsWith("v-");
  if (!isDirective || name === "v-for" || name.startsWith("v-slot")) {
    return null;
  }
  const expr = (a.value || "").trim();
  if (expr === "") {
    return null;
  }
  // v-html writes its expression to innerHTML: lift it to exactly that sink so
  // scanUnsafeHtml flags it (and still scans the expression itself). Every other
  // binding becomes a bare expression - the value is scanned, no false HTML sink.
  const code = name === "v-html" ? `__vhtml.innerHTML=(${expr})` : `(${expr})`;
  return {
    file,
    code,
    lineOffset: a.line - 1,
    inline: true,
    parseAs: ".js",
  };
}
